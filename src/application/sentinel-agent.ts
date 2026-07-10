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
  private alerts: OperationalAlert[] = [];
  private signals: Signal[] = [];
  private latestEvent: MatchEvent | undefined;
  private latestOdds: NormalizedOddsSnapshot | undefined;
  private pendingScoreEvents = new Map<string, MatchEvent>();

  public constructor(
    public readonly config: SentinelConfig,
    private readonly provider: TxLineProvider
  ) {
    this.quality = new DataQualitySentinel(config.thresholds);
    this.correlator = new EventCorrelator(config.thresholds.correlationWindowMs);
    this.signalEngine = new SignalEngine(config);
    this.paper = new PaperTradingSimulator(config.thresholds);
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
    return {
      mode: this.provider.mode,
      ready: providerReadiness.ready || this.provider.mode !== "live",
      ...(replay ? { replay } : {}),
      ...(fixture ? { fixture } : {}),
      ...(latestSignal ? { latestSignal: structuredClone(latestSignal) } : {}),
      ...(latestAlert ? { latestAlert: structuredClone(latestAlert) } : {}),
      ...(this.latestEvent ? { latestEvent: structuredClone(this.latestEvent) } : {}),
      ...(this.latestOdds ? { latestOdds: structuredClone(this.latestOdds) } : {}),
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

  public startReplay(speed?: ReplayState["speed"]): ReplayState {
    const replay = this.requireReplayProvider();
    const state = replay.start(speed);
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:start", {
      action: "start",
      speed: state.speed
    });
    return state;
  }

  public pauseReplay(): ReplayState {
    const state = this.requireReplayProvider().pause();
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:pause", {
      action: "pause"
    });
    return state;
  }

  public resumeReplay(speed?: ReplayState["speed"]): ReplayState {
    const replay = this.requireReplayProvider();
    const state = replay.resume();
    if (speed !== undefined && state.speed !== speed) {
      return replay.start(speed);
    }
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:resume", {
      action: "resume"
    });
    return state;
  }

  public resetReplay(): ReplayState {
    const replay = this.requireReplayProvider();
    const state = replay.reset();
    this.resetPipeline();
    this.auditLog.append("replay_control", this.controlTimestamp(), "replay:reset", {
      action: "reset"
    });
    return state;
  }

  public advanceReplay(): ProviderMessage | undefined {
    const replay = this.requireReplayProvider();
    const message = replay.advance();
    if (!message) {
      return undefined;
    }
    this.process(message);
    return message;
  }

  private process(message: ProviderMessage): void {
    const preflightAlerts = [
      ...this.quality.checkStaleness(message.receivedTimestamp),
      ...this.checkScoreEventDivergence(message.receivedTimestamp)
    ];
    this.recordAlerts(preflightAlerts);
    this.auditLog.append("raw_input_reference", message.receivedTimestamp, `input:${message.id}`, {
      fixtureId: message.fixtureId,
      feed: message.kind,
      updateId: message.id,
      sequence: message.sequence,
      rawReference: message.rawReference
    });
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
    this.updateFixtureForEvent(event);
    this.correlator.record(event);
    if (event.confirmed && ["goal", "red_card", "penalty", "var"].includes(event.type)) {
      this.pendingScoreEvents.set(event.id, event);
    }
    this.auditLog.append("normalized_input", event.receivedTimestamp, `event:${event.id}`, {
      fixtureId: event.fixtureId,
      eventType: event.type,
      minute: event.minute,
      confirmed: event.confirmed
    });
    if (event.type === "full_time" && event.score) {
      this.settleFixture(event.fixtureId, event.score, event.receivedTimestamp);
    }
  }

  private processOdds(
    message: Extract<ProviderMessage, { kind: "odds" }>,
    alerts: OperationalAlert[]
  ): void {
    const snapshot = normalizeOddsUpdate(message);
    this.latestOdds = structuredClone(snapshot);
    this.signals = updateCounterfactuals(this.signals, snapshot);
    const fixture = this.fixturesById.get(snapshot.fixtureId);
    if (!fixture) {
      this.auditLog.append("error", message.receivedTimestamp, `input:${message.id}`, {
        reason: "Unknown fixture received from provider",
        fixtureId: snapshot.fixtureId
      });
      return;
    }
    const correlatedEvent = this.correlator.correlate(snapshot.fixtureId, snapshot.sourceTimestamp);
    if (correlatedEvent) {
      this.pendingScoreEvents.delete(correlatedEvent.event.id);
    }
    this.auditLog.append("normalized_input", snapshot.receivedTimestamp, `odds:${snapshot.id}`, {
      fixtureId: snapshot.fixtureId,
      market: snapshot.market,
      overround: snapshot.overround,
      sourceTimestamp: snapshot.sourceTimestamp
    });
    let signal = this.signalEngine.process(snapshot, {
      fixture,
      ...(correlatedEvent ? { correlatedEvent } : {}),
      alerts
    });
    if (!signal) {
      return;
    }
    if (!correlatedEvent) {
      const divergence: OperationalAlert = {
        id: `alert-unexplained-${signal.id}`,
        type: "odds_score_divergence",
        severity: "warning",
        fixtureId: signal.fixtureId,
        feed: "odds",
        timestamp: signal.receivedTimestamp,
        message:
          "A significant odds movement had no confirmed score event inside the correlation window.",
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
    if (signal.paperDecision === "opened" && !position) {
      signal = { ...signal, paperDecision: "declined" };
    }
    signal = { ...signal, explanation: buildExplanation(signal, alerts) };
    this.signals.push(signal);
    this.auditLog.append("signal_decision", signal.receivedTimestamp, signal.correlationId, {
      signalId: signal.id,
      confidence: signal.confidence,
      rules: signal.triggeredRules,
      paperDecision: signal.paperDecision
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
    const settled = this.paper.settle(fixtureId, winner, timestamp);
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

  private checkScoreEventDivergence(now: string): OperationalAlert[] {
    const nowMs = new Date(now).getTime();
    const alerts: OperationalAlert[] = [];
    for (const [eventId, event] of this.pendingScoreEvents.entries()) {
      const ageMs = nowMs - new Date(event.sourceTimestamp).getTime();
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
    for (const alert of alerts) {
      this.alerts.push(alert);
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
    this.paper.reset();
    this.alerts = [];
    this.signals = [];
    this.latestEvent = undefined;
    this.latestOdds = undefined;
    this.pendingScoreEvents.clear();
    this.restoreFixtures();
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
    return this.replayProvider()?.getReplayState().simulatedTime ?? new Date().toISOString();
  }
}
