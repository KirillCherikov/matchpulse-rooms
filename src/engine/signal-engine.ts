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
  correlatedEvents?: CorrelatedEvent[];
  alerts: OperationalAlert[];
  activeCriticalFeed?: boolean;
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

    const eligibleCandidates = candidates.filter((candidate) => {
      const hasPrimaryThreshold = candidate.rules.some((rule) =>
        [
          "absolute_probability_shift",
          "rapid_probability_shift",
          "abnormal_relative_to_baseline"
        ].includes(rule)
      );
      const hasQualifiedMomentum =
        candidate.rules.includes("momentum_continuation") &&
        Math.abs(candidate.movement.probabilityDelta) >=
          this.config.thresholds.absoluteProbabilityMove / 2;
      return hasPrimaryThreshold || hasQualifiedMomentum;
    });
    const correlations =
      context.correlatedEvents ?? (context.correlatedEvent ? [context.correlatedEvent] : []);
    const supportedCandidates = eligibleCandidates.filter((candidate) =>
      correlations.some((correlation) =>
        this.eventSupportsDirectionalMovement(
          correlation,
          candidate.selection,
          candidate.movement.probabilityDelta
        )
      )
    );
    const supportedPositiveCandidates = supportedCandidates.filter(
      (candidate) => candidate.movement.probabilityDelta > 0
    );
    const candidatePool =
      supportedPositiveCandidates.length > 0
        ? supportedPositiveCandidates
        : supportedCandidates.length > 0
          ? supportedCandidates
          : eligibleCandidates;
    const candidate = [...candidatePool].sort(
      (left, right) =>
        Math.abs(right.movement.probabilityDelta) - Math.abs(left.movement.probabilityDelta)
    )[0];
    if (!candidate) {
      return undefined;
    }

    const directionallyConsistentEvents = correlations.filter((correlation) =>
      this.eventSupportsDirectionalMovement(
        correlation,
        candidate.selection,
        candidate.movement.probabilityDelta
      )
    );
    const directionallyConsistentEvent =
      directionallyConsistentEvents.find(
        (correlation) => correlation.relationship === "post_event_reaction"
      ) ?? directionallyConsistentEvents[0];
    const correlatedEvent = directionallyConsistentEvent ?? correlations[0];
    const rules = [...candidate.rules];
    const eventConsistent =
      correlatedEvent !== undefined &&
      this.eventSupportsDirectionalMovement(
        correlatedEvent,
        candidate.selection,
        candidate.movement.probabilityDelta
      );
    if (correlatedEvent) {
      rules.push("temporally_associated_event");
      if (correlatedEvent.relationship === "late_event_confirmation") {
        rules.push("late_event_confirmation");
      }
      if (eventConsistent) {
        rules.push("event_consistent_movement");
        if (correlatedEvent.relationship === "post_event_reaction") {
          rules.push("confirmed_match_event");
        }
      } else {
        rules.push("event_market_divergence");
      }
    } else {
      rules.push("unexplained_market_movement");
    }
    if (context.activeCriticalFeed || context.alerts.some((alert) => alert.severity !== "info")) {
      rules.push("data_quality_warning");
    }
    const confidence = this.calculateRuleBasedConfidence(
      rules,
      context.alerts,
      context.activeCriticalFeed === true
    );
    const criticalFeedIssue =
      context.activeCriticalFeed || context.alerts.some((alert) => alert.severity === "critical");
    const paperDecision =
      eventConsistent &&
      correlatedEvent?.relationship === "post_event_reaction" &&
      candidate.movement.probabilityDelta > 0 &&
      candidate.selection !== "draw" &&
      context.fixture.status === "live" &&
      confidence.score >= this.config.thresholds.minRuleBasedConfidenceToTrade &&
      !criticalFeedIssue
        ? "eligible"
        : "not_eligible";
    this.signalSequence += 1;
    const latencyMs =
      new Date(snapshot.receivedTimestamp).getTime() - new Date(snapshot.sourceTimestamp).getTime();
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
      ...(correlatedEvent ? { correlatedEvent } : {}),
      latencyMs,
      ruleBasedConfidenceScore: confidence.score,
      confidenceComponents: confidence.components,
      triggeredRules: rules,
      explanation: {
        summary: "Explanation pending deterministic template rendering.",
        dataQuality: "Data quality is evaluated with the signal.",
        decision: "Paper decision is evaluated with the signal.",
        reasons: []
      },
      paperDecision,
      strategyConfigurationVersion: this.config.strategyConfigurationVersion,
      counterfactual: {
        horizons: [],
        immediateEntryOdds: candidate.after.decimalOdds
      }
    };
  }

  private calculateRuleBasedConfidence(
    rules: string[],
    alerts: OperationalAlert[],
    activeCriticalFeed: boolean
  ): { score: number; components: Signal["confidenceComponents"] } {
    const weights = this.config.confidenceWeights;
    const components: Signal["confidenceComponents"] = [
      { component: "base", contribution: weights.base }
    ];
    const add = (rule: string, contribution: number): void => {
      if (rules.includes(rule)) components.push({ component: rule, contribution });
    };
    add("absolute_probability_shift", weights.absoluteProbabilityShift);
    add("rapid_probability_shift", weights.rapidProbabilityShift);
    add("abnormal_relative_to_baseline", weights.abnormalRelativeToBaseline);
    add("momentum_continuation", weights.momentumContinuation);
    add("confirmed_match_event", weights.confirmedMatchEvent);
    add("late_event_confirmation", weights.lateEventConfirmation);
    add("unexplained_market_movement", weights.unexplainedMovement);
    if (activeCriticalFeed || alerts.some((alert) => alert.severity === "critical")) {
      components.push({
        component: "critical_data_quality",
        contribution: weights.criticalPenalty
      });
    } else if (alerts.some((alert) => alert.severity === "warning")) {
      components.push({ component: "warning_data_quality", contribution: weights.warningPenalty });
    }
    const rawScore = components.reduce((sum, component) => sum + component.contribution, 0);
    return {
      score: Math.max(weights.minimum, Math.min(weights.maximum, Number(rawScore.toFixed(2)))),
      components
    };
  }

  private eventSupportsDirectionalMovement(
    correlatedEvent: CorrelatedEvent,
    selection: SelectionKey,
    probabilityDelta: number
  ): boolean {
    if (probabilityDelta === 0 || selection === "draw") return false;
    const event = correlatedEvent.event;
    if (!event.team) return false;
    if (event.type === "goal") {
      return event.team === selection ? probabilityDelta > 0 : probabilityDelta < 0;
    }
    if (event.type === "red_card") {
      return event.team === selection ? probabilityDelta < 0 : probabilityDelta > 0;
    }
    return false;
  }
}
