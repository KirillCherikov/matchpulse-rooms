import { AppendOnlyAuditLog } from "../audit/audit-log.js";
import { loadConfig, type SentinelConfig } from "../config.js";
import type {
  AgentStatus,
  Analytics,
  Fixture,
  MatchEvent,
  NormalizedOddsSnapshot,
  OperationalAlert,
  PaperPosition,
  ProviderMessage,
  ReplayState,
  SelectionKey,
  Signal
} from "../domain/models.js";
import { DataQualitySentinel } from "../engine/data-quality.js";
import { EventCorrelator } from "../engine/correlation.js";
import { updateCounterfactuals } from "../engine/counterfactual.js";
import { buildExplanation } from "../engine/explainability.js";
import { normalizeOddsUpdate } from "../engine/odds.js";
import { PaperTradingSimulator } from "../engine/paper-trading.js";
import { SignalEngine } from "../engine/signal-engine.js";
import { TelegramNotifier } from "../notifications/telegram.js";
import { LiveTxLineProvider } from "../providers/live.js";
import { MockTxLineProvider } from "../providers/mock.js";
import { ReplayTxLineProvider } from "../providers/replay.js";
import {
  createSyntheticFixture,
  createSyntheticReplayMessages
} from "../providers/synthetic-replay.js";
import type { ControllableReplayProvider, TxLineProvider } from "../providers/types.js";

export class SentinelAgent {
  private readonly auditLog = new AppendOnlyAuditLog();
  private readonly fixturesById = new Map<string, Fixture>();
  private readonly quality: DataQualitySentinel;
  private readonly correlator: EventCorrelator;
  private readonly signalEngine: SignalEngine;
  private readonly paper: PaperTradingSimulator;
  private readonly telegram: TelegramNotifier;
  private alerts: OperationalAlert[] = [];
  private signals: Signal[] = [];
  private latestEvent: MatchEvent | undefined;
  private latestConfirmedEvent: MatchEvent | undefined;
  private latestOdds: NormalizedOddsSnapshot | undefined;
  private pendingScoreEvents = new Map<string, MatchEvent>();
  private readonly malformedAlertKeys = new Set<string>();
  private replayRunSequence = 1;
  private replayRunId = "replay-run-0001";

  public constructor(
    public readonly config: SentinelConfig,
    private readonly provider: TxLineProvider
  ) {
    this.quality = new DataQualitySentinel(config.thresholds);
    this.correlator = new EventCorrelator(config.thresholds.correlationWindowMs);
    this.signalEngine = new SignalEngine(config);
    this.paper = new PaperTradingSimulator(config.thresholds);
    this.telegram = new TelegramNotifier({
      ...config.telegram,
      highConfidenceScore: config.thresholds.highConfidenceNotificationScore
    });
    this.paper.reset(this.replayRunId);
    this.auditLog.beginRun(this.replayRunId);
    this.restoreFixtures();
  }

  public static create(config: SentinelConfig = loadConfig()): SentinelAgent {
    const provider =
      config.mode === "live"
        ? new LiveTxLineProvider(Boolean(config.txline.apiToken && config.txline.guestJwt))
        : config.mode === "mock"
          ? new MockTxLineProvider()
          : new ReplayTxLineProvider([createSyntheticFixture()], createSyntheticReplayMessages());
    return new SentinelAgent(config, provider);
  }

  public status(): AgentStatus {
    const providerReadiness = this.provider.readiness();
    const fixture = this.fixtures()[0];
    const replay = this.replayProvider()?.getReplayState();
    const latestSignal = this.signals.at(-1);
    const latestAlert = this.alerts.at(-1);
    const healthTimestamp =
      replay?.simulatedTime ??
      this.latestOdds?.receivedTimestamp ??
      this.latestEvent?.receivedTimestamp ??
      new Date(0).toISOString();
    const feedHealth = fixture
      ? this.quality.feedHealth(fixture.id, healthTimestamp)
      : {
          status: "unknown" as const,
          odds: { status: "unknown" as const },
          score: { status: "unknown" as const }
        };
    return {
      mode: this.provider.mode,
      ready: providerReadiness.ready || this.provider.mode !== "live",
      ...(replay ? { replay } : {}),
      ...(fixture ? { fixture } : {}),
      ...(latestSignal ? { latestSignal: structuredClone(latestSignal) } : {}),
      ...(latestAlert ? { latestAlert: structuredClone(latestAlert) } : {}),
      ...(this.latestEvent ? { latestEvent: structuredClone(this.latestEvent) } : {}),
      ...(this.latestConfirmedEvent
        ? { latestConfirmedEvent: structuredClone(this.latestConfirmedEvent) }
        : {}),
      ...(this.latestOdds ? { latestOdds: structuredClone(this.latestOdds) } : {}),
      feedHealth,
      auditEvents: this.auditLog.count(),
      disclaimer: "SIMULATION ONLY — NO REAL MONEY"
    };
  }

  public readiness(): { ready: boolean; reason?: string } {
    if (this.provider.mode !== "live") {
      return { ready: true };
    }
    return this.provider.readiness();
  }

  public fixtures(): Fixture[] {
    return structuredClone([...this.fixturesById.values()]);
  }

  public allSignals(): Signal[] {
    return structuredClone(this.signals);
  }

  public signal(id: string): Signal | undefined {
    const signal = this.signals.find((candidate) => candidate.id === id);
    return signal ? structuredClone(signal) : undefined;
  }

  public allAlerts(): OperationalAlert[] {
    return structuredClone(this.alerts);
  }

  public positions(): PaperPosition[] {
    return this.paper.allPositions();
  }

  public analytics(): Analytics {
    return this.paper.analytics(this.signals);
  }

  public audit(limit?: number) {
    return this.auditLog.all(limit);
  }

  public exportAudit(): string {
    return this.auditLog.exportJson();
  }

  public telegramCommand(command: string): string {
    return this.telegram.commandReply(command, this);
  }

  public ingestLivePayload(rawPayload: unknown): ProviderMessage | undefined {
    if (!(this.provider instanceof LiveTxLineProvider)) {
      throw new Error("Live payload ingestion is available only with LiveTxLineProvider");
    }
    try {
      const message = this.provider.ingest(rawPayload);
      this.process(message);
      return message;
    } catch (error) {
      const timestamp = new Date().toISOString();
      const rawRecord =
        typeof rawPayload === "object" && rawPayload !== null
          ? (rawPayload as Record<string, unknown>)
          : undefined;
      const feed = rawRecord?.kind === "score" ? "score" : "odds";
      const fixtureId =
        typeof rawRecord?.fixtureId === "string" &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(rawRecord.fixtureId)
          ? rawRecord.fixtureId
          : "unknown";
      const suppressionKey = `${fixtureId}:${feed}`;
      if (this.malformedAlertKeys.has(suppressionKey)) return undefined;
      this.malformedAlertKeys.add(suppressionKey);
      while (this.malformedAlertKeys.size > 100) {
        const oldest = this.malformedAlertKeys.values().next().value;
        if (oldest === undefined) break;
        this.malformedAlertKeys.delete(oldest);
      }
      const alert: OperationalAlert = {
        id: "alert-malformed-live-payload",
        type: "malformed_payload",
        severity: "critical",
        fixtureId,
        feed,
        timestamp,
        message: "A live provider payload failed schema validation and was not processed.",
        correlationId: `quality:${fixtureId}:${feed}:malformed`,
        metadata: {
          validationError: error instanceof Error ? error.name : "UnknownError"
        }
      };
      this.recordAlerts([alert]);
      this.auditLog.append("error", timestamp, this.scopeIdentifier(alert.correlationId), {
        reason: "live_payload_validation_failed",
        fixtureId,
        feed
      });
      return undefined;
    }
  }

  public startReplay(speed?: ReplayState["speed"]): ReplayState {
    this.assertAuditCapacity(4);
    const replay = this.requireReplayProvider();
    if (replay.getReplayState().status === "finished") {
      this.auditLog.append(
        "replay_control",
        this.controlTimestamp(),
        "replay:restart-after-finished",
        { action: "restart_after_finished", previousRun: this.pipelineSummary() }
      );
      replay.reset();
      this.beginNewReplayRun();
    }
    const state = replay.start(speed);
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:start", {
      action: "start",
      speed: state.speed
    });
    return state;
  }

  public pauseReplay(): ReplayState {
    this.assertAuditCapacity(1);
    const state = this.requireReplayProvider().pause();
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:pause", {
      action: "pause"
    });
    return state;
  }

  public resumeReplay(speed?: ReplayState["speed"]): ReplayState {
    this.assertAuditCapacity(1);
    const replay = this.requireReplayProvider();
    const resumed = replay.resume();
    const state = speed !== undefined && resumed.speed !== speed ? replay.start(speed) : resumed;
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:resume", {
      action: "resume"
    });
    return state;
  }

  public resetReplay(): ReplayState {
    this.assertAuditCapacity(2);
    const replay = this.requireReplayProvider();
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:reset-requested", {
      action: "reset_requested",
      previousRun: this.pipelineSummary()
    });
    const state = replay.reset();
    this.beginNewReplayRun();
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:reset", {
      action: "reset"
    });
    return state;
  }

  public advanceReplay(manual = false): ProviderMessage | undefined {
    this.assertAuditCapacity(64);
    const replay = this.requireReplayProvider();
    if (manual) replay.pause();
    const message = replay.advance();
    if (!message) {
      return undefined;
    }
    this.process(message);
    return message;
  }

  private process(message: ProviderMessage): void {
    const inputCorrelationId = this.inputCorrelationId(message.id);
    this.auditLog.append("raw_input_reference", message.receivedTimestamp, inputCorrelationId, {
      fixtureId: message.fixtureId,
      feed: message.kind,
      updateId: message.id,
      sequence: message.sequence,
      rawReference: message.rawReference
    });
    if (!this.fixturesById.has(message.fixtureId)) {
      this.auditLog.append("error", message.receivedTimestamp, inputCorrelationId, {
        reason: "Unknown fixture received from provider",
        fixtureId: message.fixtureId
      });
      return;
    }
    const preflightAlerts = [
      ...this.quality.checkStaleness(message.receivedTimestamp),
      ...this.checkScoreEventDivergence(message.receivedTimestamp)
    ];
    this.recordAlerts(preflightAlerts);
    const inspection = this.quality.inspect(message);
    this.recordAlerts(inspection.alerts);
    if (!inspection.shouldProcess) {
      return;
    }

    if (message.kind === "score") {
      this.processMatchEvent(message);
      return;
    }
    this.processOdds(message, [...preflightAlerts, ...inspection.alerts]);
  }

  private processMatchEvent(event: MatchEvent): void {
    this.latestEvent = structuredClone(event);
    this.auditLog.append(
      "normalized_input",
      event.receivedTimestamp,
      this.inputCorrelationId(event.id),
      {
        fixtureId: event.fixtureId,
        eventType: event.type,
        minute: event.minute,
        confirmed: event.confirmed,
        authoritative: event.confirmed
      }
    );
    if (!event.confirmed) return;
    this.latestConfirmedEvent = structuredClone(event);
    this.updateFixtureForEvent(event);
    this.correlator.record(event);
    if (["goal", "red_card", "penalty", "var"].includes(event.type)) {
      this.pendingScoreEvents.set(event.id, event);
    }
    if (event.type === "full_time" && event.score) {
      this.settleFixture(event.fixtureId, event.score, event.receivedTimestamp);
    } else if (event.type === "cancelled" || event.type === "postponed") {
      this.settlePositions(event.fixtureId, "void", event.receivedTimestamp);
    }
  }

  private processOdds(
    message: Extract<ProviderMessage, { kind: "odds" }>,
    alerts: OperationalAlert[]
  ): void {
    const snapshot = normalizeOddsUpdate(message);
    this.latestOdds = structuredClone(snapshot);
    const beforeCounterfactualCounts = new Map(
      this.signals.map((signal) => [signal.id, signal.counterfactual.horizons.length])
    );
    this.signals = updateCounterfactuals(this.signals, snapshot, {
      persistenceRatio: this.config.thresholds.counterfactualPersistenceRatio,
      reversalRatio: this.config.thresholds.counterfactualReversalRatio,
      maxObservationLagSeconds: this.config.thresholds.counterfactualMaxObservationLagSeconds
    });
    for (const evaluatedSignal of this.signals) {
      const previousCount = beforeCounterfactualCounts.get(evaluatedSignal.id) ?? 0;
      const newPoints = evaluatedSignal.counterfactual.horizons.slice(previousCount);
      if (newPoints.length > 0) {
        this.auditLog.append(
          "counterfactual_evaluation",
          snapshot.receivedTimestamp,
          evaluatedSignal.correlationId,
          { signalId: evaluatedSignal.id, snapshotId: snapshot.id, points: newPoints }
        );
      }
    }
    const fixture = this.fixturesById.get(snapshot.fixtureId);
    if (!fixture) {
      this.auditLog.append(
        "error",
        message.receivedTimestamp,
        this.inputCorrelationId(message.id),
        {
          reason: "Unknown fixture received from provider",
          fixtureId: snapshot.fixtureId
        }
      );
      return;
    }
    const correlatedEvent = this.correlator.correlate(
      snapshot.fixtureId,
      snapshot.sourceTimestamp,
      snapshot.receivedTimestamp
    );
    this.auditLog.append(
      "normalized_input",
      snapshot.receivedTimestamp,
      this.inputCorrelationId(snapshot.id),
      {
        fixtureId: snapshot.fixtureId,
        market: snapshot.market,
        bookPercentage: snapshot.bookPercentage,
        overround: snapshot.overround,
        sourceTimestamp: snapshot.sourceTimestamp
      }
    );
    let signal = this.signalEngine.process(snapshot, {
      fixture,
      ...(correlatedEvent ? { correlatedEvent } : {}),
      alerts,
      activeCriticalFeed: this.quality.hasStaleFeed(snapshot.fixtureId)
    });
    if (!signal) {
      return;
    }
    signal = {
      ...signal,
      id: `${this.replayRunId}:${signal.id}`,
      correlationId: this.inputCorrelationId(snapshot.id)
    };
    const eventConsistent = signal.triggeredRules.includes("event_consistent_movement");
    if (eventConsistent && correlatedEvent) {
      this.pendingScoreEvents.delete(correlatedEvent.event.id);
    }
    if (!correlatedEvent || !eventConsistent) {
      const divergence: OperationalAlert = {
        id: `alert-unexplained-${signal.id}`,
        type: "odds_score_divergence",
        severity: "warning",
        fixtureId: signal.fixtureId,
        feed: "odds",
        timestamp: signal.receivedTimestamp,
        message: correlatedEvent
          ? "A significant odds movement was not directionally supported by the associated event."
          : "A significant odds movement had no causal confirmed score event inside the correlation window.",
        correlationId: signal.correlationId,
        metadata: {
          signalId: signal.id,
          correlationWindowMs: this.config.thresholds.correlationWindowMs
        }
      };
      this.recordAlerts([divergence]);
      alerts = [...alerts, divergence];
    }
    const position = this.paper.openForSignal(signal);
    signal = {
      ...signal,
      paperDecision: position
        ? "opened"
        : signal.paperDecision === "eligible"
          ? "declined"
          : signal.paperDecision
    };
    signal = { ...signal, explanation: buildExplanation(signal, alerts) };
    this.signals.push(signal);
    void this.telegram.notifyHighConfidenceSignal(signal);
    this.auditLog.append("signal_decision", signal.receivedTimestamp, signal.correlationId, {
      signalId: signal.id,
      ruleBasedConfidenceScore: signal.ruleBasedConfidenceScore,
      confidenceComponents: signal.confidenceComponents,
      rules: signal.triggeredRules,
      paperDecision: signal.paperDecision,
      strategyConfigurationVersion: signal.strategyConfigurationVersion,
      oddsBefore: signal.oddsBefore,
      oddsAfter: signal.oddsAfter,
      latencyMs: signal.latencyMs,
      correlatedEvent: signal.correlatedEvent,
      explanation: signal.explanation
    });
    if (position) {
      this.auditLog.append("paper_execution", position.openedAt, signal.correlationId, {
        positionId: position.id,
        signalId: signal.id,
        stake: position.stake,
        entryOdds: position.entryOdds,
        disclaimer: position.note
      });
    }
  }

  private updateFixtureForEvent(event: MatchEvent): void {
    const fixture = this.fixturesById.get(event.fixtureId);
    if (!fixture) {
      return;
    }
    const next: Fixture = {
      ...fixture,
      minute: event.minute,
      ...(event.score ? { score: event.score } : {}),
      ...(event.type === "kickoff" ? { status: "live" } : {}),
      ...(event.type === "full_time" ? { status: "finished" } : {}),
      ...(event.type === "cancelled" || event.type === "postponed" ? { status: "cancelled" } : {})
    };
    this.fixturesById.set(event.fixtureId, next);
  }

  private settleFixture(
    fixtureId: string,
    score: { home: number; away: number },
    timestamp: string
  ): void {
    const winner: SelectionKey =
      score.home === score.away ? "draw" : score.home > score.away ? "home" : "away";
    this.settlePositions(fixtureId, winner, timestamp);
  }

  private settlePositions(
    fixtureId: string,
    result: SelectionKey | "void",
    timestamp: string
  ): void {
    const settled = this.paper.settle(fixtureId, result, timestamp);
    this.evaluateEntryAlternatives(fixtureId, result);
    for (const position of settled) {
      const index = this.signals.findIndex((signal) => signal.id === position.signalId);
      if (index === -1) {
        continue;
      }
      const signal = this.signals[index];
      if (!signal) {
        continue;
      }
      this.signals[index] = {
        ...signal,
        outcome: {
          settledAt: timestamp,
          ...(position.outcome ? { positionOutcome: position.outcome } : {}),
          ...(position.virtualPnl !== undefined ? { virtualPnl: position.virtualPnl } : {})
        }
      };
      this.auditLog.append("settlement", timestamp, signal.correlationId, {
        positionId: position.id,
        signalId: signal.id,
        outcome: position.outcome,
        virtualPnl: position.virtualPnl,
        disclaimer: "SIMULATION ONLY — NO REAL MONEY"
      });
    }
  }

  private evaluateEntryAlternatives(fixtureId: string, result: SelectionKey | "void"): void {
    this.signals = this.signals.map((signal) => {
      if (signal.fixtureId !== fixtureId) return signal;
      if (result === "void") {
        return {
          ...signal,
          counterfactual: {
            ...signal.counterfactual,
            immediateReturn: 0,
            ...(signal.counterfactual.confirmationEntryOdds !== undefined
              ? { confirmationReturn: 0, betterEntry: "equal" as const }
              : { betterEntry: "unavailable" as const })
          }
        };
      }
      const selectedOutcomeWon = signal.selection === result;
      const immediateReturn = selectedOutcomeWon
        ? Number((signal.counterfactual.immediateEntryOdds - 1).toFixed(4))
        : -1;
      const confirmationReturn =
        signal.counterfactual.confirmationEntryOdds === undefined
          ? undefined
          : selectedOutcomeWon
            ? Number((signal.counterfactual.confirmationEntryOdds - 1).toFixed(4))
            : -1;
      const betterEntry =
        confirmationReturn === undefined
          ? ("unavailable" as const)
          : immediateReturn > confirmationReturn
            ? ("immediate" as const)
            : confirmationReturn > immediateReturn
              ? ("confirmation" as const)
              : ("equal" as const);
      return {
        ...signal,
        counterfactual: {
          ...signal.counterfactual,
          immediateReturn,
          ...(confirmationReturn !== undefined ? { confirmationReturn } : {}),
          betterEntry
        }
      };
    });
  }

  private checkScoreEventDivergence(now: string): OperationalAlert[] {
    const nowMs = new Date(now).getTime();
    const alerts: OperationalAlert[] = [];
    for (const [eventId, event] of this.pendingScoreEvents.entries()) {
      const ageMs = nowMs - new Date(event.receivedTimestamp).getTime();
      if (ageMs > this.config.thresholds.correlationWindowMs) {
        this.pendingScoreEvents.delete(eventId);
        alerts.push({
          id: `alert-divergence-${eventId}`,
          type: "odds_score_divergence",
          severity: "warning",
          fixtureId: event.fixtureId,
          feed: "score",
          timestamp: now,
          message: `Confirmed ${event.type} at ${event.minute}' had no correlated odds movement in the configured window.`,
          correlationId: `event:${event.id}`,
          metadata: {
            eventId: event.id,
            ageMs,
            correlationWindowMs: this.config.thresholds.correlationWindowMs
          }
        });
      }
    }
    return alerts;
  }

  private recordAlerts(alerts: OperationalAlert[]): void {
    for (const originalAlert of alerts) {
      const alert: OperationalAlert = {
        ...originalAlert,
        id: this.scopeIdentifier(originalAlert.id),
        correlationId: this.scopeIdentifier(originalAlert.correlationId)
      };
      this.alerts.push(alert);
      if (alert.type === "feed_recovery") {
        void this.telegram.notifyRecovery(alert);
      } else {
        void this.telegram.notifyOperationalAlert(alert);
      }
      this.auditLog.append(
        alert.type === "feed_recovery" ? "recovery" : "operational_alert",
        alert.timestamp,
        alert.correlationId,
        {
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          metadata: alert.metadata
        }
      );
    }
  }

  private resetPipeline(): void {
    this.quality.reset();
    this.correlator.reset();
    this.signalEngine.reset();
    this.paper.reset(this.replayRunId);
    this.alerts = [];
    this.signals = [];
    this.latestEvent = undefined;
    this.latestConfirmedEvent = undefined;
    this.latestOdds = undefined;
    this.pendingScoreEvents.clear();
    this.malformedAlertKeys.clear();
    this.restoreFixtures();
  }

  private beginNewReplayRun(): void {
    this.replayRunSequence += 1;
    this.replayRunId = `replay-run-${String(this.replayRunSequence).padStart(4, "0")}`;
    this.auditLog.beginRun(this.replayRunId);
    this.resetPipeline();
  }

  private pipelineSummary(): Record<string, number> {
    return {
      signals: this.signals.length,
      alerts: this.alerts.length,
      positions: this.paper.allPositions().length,
      auditEvents: this.auditLog.count()
    };
  }

  private inputCorrelationId(inputId: string): string {
    return `${this.replayRunId}:input:${inputId}`;
  }

  private scopeIdentifier(identifier: string): string {
    return identifier.startsWith(`${this.replayRunId}:`)
      ? identifier
      : `${this.replayRunId}:${identifier}`;
  }

  private assertAuditCapacity(requiredEvents: number): void {
    if (this.auditLog.remainingCapacity() < requiredEvents) {
      throw new Error("Audit capacity is too low to process another replay action safely");
    }
  }

  private restoreFixtures(): void {
    this.fixturesById.clear();
    for (const fixture of this.provider.fixtures()) {
      this.fixturesById.set(fixture.id, structuredClone(fixture));
    }
  }

  private replayProvider(): ControllableReplayProvider | undefined {
    const candidate = this.provider as Partial<ControllableReplayProvider>;
    return typeof candidate.advance === "function" && typeof candidate.getReplayState === "function"
      ? (candidate as ControllableReplayProvider)
      : undefined;
  }

  private requireReplayProvider(): ControllableReplayProvider {
    const replay = this.replayProvider();
    if (!replay) {
      throw new Error("Replay controls are unavailable in live mode.");
    }
    return replay;
  }

  private controlTimestamp(): string {
    const replay = this.replayProvider();
    if (replay) return replay.getReplayState().simulatedTime ?? new Date(0).toISOString();
    return new Date().toISOString();
  }
}
