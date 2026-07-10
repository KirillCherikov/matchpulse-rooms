import type { SentinelConfig } from "../config.js";
import type {
  CorrelatedEvent,
  Fixture,
  NormalizedOddsSnapshot,
  OperationalAlert,
  SelectionKey,
  Signal
} from "../domain/models.js";
import { calculateMovement, selectionFor } from "./odds.js";

interface SelectionState {
  movements: number[];
  previousVelocity: number;
}

export interface SignalContext {
  fixture: Fixture;
  correlatedEvent?: CorrelatedEvent;
  alerts: OperationalAlert[];
}

interface Candidate {
  selection: SelectionKey;
  movement: Signal["movement"];
  before: ReturnType<typeof selectionFor>;
  after: ReturnType<typeof selectionFor>;
  rules: string[];
}

export class SignalEngine {
  private readonly snapshots = new Map<string, NormalizedOddsSnapshot>();
  private readonly selectionStates = new Map<string, SelectionState>();
  private signalSequence = 0;

  public constructor(private readonly config: SentinelConfig) {}

  public reset(): void {
    this.snapshots.clear();
    this.selectionStates.clear();
    this.signalSequence = 0;
  }

  public process(snapshot: NormalizedOddsSnapshot, context: SignalContext): Signal | undefined {
    const marketKey = `${snapshot.fixtureId}:${snapshot.market}`;
    const previous = this.snapshots.get(marketKey);
    if (!previous) {
      this.snapshots.set(marketKey, snapshot);
      return undefined;
    }

    const candidates: Candidate[] = snapshot.selections.map((currentSelection) => {
      const selection = currentSelection.selection;
      const stateKey = `${marketKey}:${selection}`;
      const state = this.selectionStates.get(stateKey) ?? { movements: [], previousVelocity: 0 };
      const movement = calculateMovement(
        previous,
        snapshot,
        selection,
        state.movements,
        state.previousVelocity
      );
      const rules: string[] = [];
      if (Math.abs(movement.probabilityDelta) >= this.config.thresholds.absoluteProbabilityMove) {
        rules.push("absolute_probability_shift");
      }
      if (Math.abs(movement.velocityPerSecond) >= this.config.thresholds.rapidVelocityPerSecond) {
        rules.push("rapid_probability_shift");
      }
      if (
        movement.rollingBaseline.sampleSize >= 3 &&
        Math.abs(movement.probabilityDelta) >
          movement.rollingBaseline.meanAbsoluteMovement +
            this.config.thresholds.baselineZScore * movement.rollingBaseline.standardDeviation
      ) {
        rules.push("abnormal_relative_to_baseline");
      }
      if (state.previousVelocity !== 0 && state.previousVelocity * movement.velocityPerSecond > 0) {
        rules.push("momentum_continuation");
      }
      if (state.previousVelocity !== 0 && state.previousVelocity * movement.velocityPerSecond < 0) {
        rules.push("market_reversal");
      }
      state.movements.push(movement.probabilityDelta);
      if (state.movements.length > this.config.thresholds.rollingWindowSize) {
        state.movements.shift();
      }
      state.previousVelocity = movement.velocityPerSecond;
      this.selectionStates.set(stateKey, state);
      return {
        selection,
        movement,
        before: selectionFor(previous, selection),
        after: selectionFor(snapshot, selection),
        rules
      };
    });
    this.snapshots.set(marketKey, snapshot);

    const candidate = candidates.sort(
      (left, right) =>
        Math.abs(right.movement.probabilityDelta) - Math.abs(left.movement.probabilityDelta)
    )[0];
    const hasPrimaryThreshold = candidate?.rules.some((rule) =>
      [
        "absolute_probability_shift",
        "rapid_probability_shift",
        "abnormal_relative_to_baseline"
      ].includes(rule)
    );
    const hasQualifiedMomentum =
      candidate?.rules.includes("momentum_continuation") &&
      Math.abs(candidate.movement.probabilityDelta) >=
        this.config.thresholds.absoluteProbabilityMove / 2;
    if (!candidate || (!hasPrimaryThreshold && !hasQualifiedMomentum)) {
      return undefined;
    }

    const rules = [...candidate.rules];
    if (context.correlatedEvent) {
      rules.push("confirmed_match_event");
    } else {
      rules.push("unexplained_market_movement");
    }
    if (context.alerts.some((alert) => alert.severity !== "info")) {
      rules.push("data_quality_warning");
    }
    const confidence = this.calculateConfidence(rules, context.alerts);
    const criticalFeedIssue = context.alerts.some((alert) => alert.severity === "critical");
    const paperDecision =
      context.correlatedEvent &&
      confidence >= this.config.thresholds.minConfidenceToTrade &&
      !criticalFeedIssue
        ? "opened"
        : "not_eligible";
    this.signalSequence += 1;
    const latencyMs = Math.max(
      0,
      new Date(snapshot.receivedTimestamp).getTime() - new Date(snapshot.sourceTimestamp).getTime()
    );
    return {
      id: `signal-${String(this.signalSequence).padStart(4, "0")}`,
      correlationId: `signal:${snapshot.fixtureId}:${snapshot.id}`,
      fixtureId: snapshot.fixtureId,
      competition: context.fixture.competition,
      market: snapshot.market,
      selection: candidate.selection,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedTimestamp: snapshot.receivedTimestamp,
      matchMinute: context.fixture.minute,
      oddsBefore: candidate.before.decimalOdds,
      oddsAfter: candidate.after.decimalOdds,
      impliedProbabilityBefore: candidate.before.impliedProbability,
      impliedProbabilityAfter: candidate.after.impliedProbability,
      normalizedProbabilityBefore: candidate.before.normalizedProbability,
      normalizedProbabilityAfter: candidate.after.normalizedProbability,
      movement: candidate.movement,
      ...(context.correlatedEvent ? { correlatedEvent: context.correlatedEvent } : {}),
      latencyMs,
      confidence,
      triggeredRules: rules,
      explanation: {
        summary: "Explanation pending deterministic template rendering.",
        dataQuality: "Data quality is evaluated with the signal.",
        decision: "Paper decision is evaluated with the signal.",
        reasons: []
      },
      paperDecision,
      strategyConfigurationVersion: "2026-07-replay-mvp",
      counterfactual: { horizons: [], immediateEntryOdds: candidate.after.decimalOdds }
    };
  }

  private calculateConfidence(rules: string[], alerts: OperationalAlert[]): number {
    let confidence = 0.32;
    if (rules.includes("absolute_probability_shift")) confidence += 0.16;
    if (rules.includes("rapid_probability_shift")) confidence += 0.14;
    if (rules.includes("abnormal_relative_to_baseline")) confidence += 0.08;
    if (rules.includes("momentum_continuation")) confidence += 0.06;
    if (rules.includes("confirmed_match_event")) confidence += 0.22;
    if (rules.includes("unexplained_market_movement")) confidence -= 0.03;
    if (alerts.some((alert) => alert.severity === "warning")) confidence -= 0.12;
    if (alerts.some((alert) => alert.severity === "critical")) confidence -= 0.35;
    return Math.max(0.05, Math.min(0.98, Number(confidence.toFixed(2))));
  }
}
