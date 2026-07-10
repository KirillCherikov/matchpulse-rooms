import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { CorrelatedEvent, OddsUpdate } from "../../src/domain/models.js";
import { EventCorrelator } from "../../src/engine/correlation.js";
import { DataQualitySentinel } from "../../src/engine/data-quality.js";
import { normalizeOddsUpdate } from "../../src/engine/odds.js";
import { SignalEngine } from "../../src/engine/signal-engine.js";
import { fixture, matchEvent, oddsUpdate, timestamp } from "../helpers.js";

function postEventGoal(seconds = 8): CorrelatedEvent {
  const event = matchEvent("goal", 1, seconds);
  return {
    event,
    relationship: "post_event_reaction",
    sourceLagMs: 2_000,
    confirmationLeadMs: 2_000
  };
}

function withAwayOdds(update: OddsUpdate, awayOdds: number): OddsUpdate {
  return {
    ...update,
    selections: update.selections.map((selection) =>
      selection.selection === "away" ? { ...selection, decimalOdds: awayOdds } : selection
    )
  };
}

function fairOddsUpdate(
  id: string,
  sequence: number,
  seconds: number,
  probabilities: [number, number, number]
): OddsUpdate {
  return {
    kind: "odds",
    id,
    fixtureId: fixture.id,
    market: "match_winner",
    sequence,
    sourceTimestamp: timestamp(seconds),
    receivedTimestamp: timestamp(seconds),
    selections: [
      { selection: "home", decimalOdds: 1 / probabilities[0] },
      { selection: "draw", decimalOdds: 1 / probabilities[1] },
      { selection: "away", decimalOdds: 1 / probabilities[2] }
    ],
    rawReference: `test://odds/${id}`
  };
}

describe("event correlation and signal detection", () => {
  it("correlates only an already available event that precedes the odds source time", () => {
    const correlator = new EventCorrelator(30_000);
    const event = matchEvent("goal", 1, 30);
    correlator.record(event);

    const correlation = correlator.correlate(fixture.id, timestamp(50), timestamp(50));
    expect(correlation).toMatchObject({
      relationship: "post_event_reaction",
      sourceLagMs: 20_000,
      confirmationLeadMs: 20_000
    });
    expect(correlation?.event.id).toBe("goal");
    expect(correlator.correlate(fixture.id, timestamp(70), timestamp(70))).toBeUndefined();
  });

  it("does not use a future-source event even when it was received before the decision", () => {
    const correlator = new EventCorrelator(30_000);
    correlator.record(matchEvent("future-goal", 1, 60));

    expect(correlator.correlate(fixture.id, timestamp(50), timestamp(70))).toBeUndefined();
  });

  it("does not expose an event before receipt and labels later receipt as retrospective", () => {
    const correlator = new EventCorrelator(30_000);
    const event = {
      ...matchEvent("delayed-goal", 1, 30),
      receivedTimestamp: timestamp(55)
    };
    correlator.record(event);

    expect(correlator.correlate(fixture.id, timestamp(50), timestamp(54))).toBeUndefined();
    expect(correlator.correlate(fixture.id, timestamp(50), timestamp(60))).toMatchObject({
      relationship: "late_event_confirmation",
      sourceLagMs: 20_000,
      confirmationLeadMs: 5_000
    });
  });

  it("detects duplicate, gap, out-of-order, stale, delayed, and recovery conditions", () => {
    const sentinel = new DataQualitySentinel({
      staleOddsMs: 10_000,
      staleScoreMs: 10_000,
      delayedUpdateMs: 1_000,
      seenIdLimitPerFeed: 100
    });
    const first = oddsUpdate("one", 1, 0);
    expect(sentinel.inspect(first).shouldProcess).toBe(true);
    expect(sentinel.inspect(first).alerts.map((alert) => alert.type)).toContain("duplicate_update");
    expect(sentinel.inspect(oddsUpdate("three", 3, 2)).alerts.map((alert) => alert.type)).toContain(
      "sequence_gap"
    );
    expect(sentinel.inspect(oddsUpdate("two", 2, 3)).alerts.map((alert) => alert.type)).toContain(
      "out_of_order_update"
    );
    expect(sentinel.checkStaleness(timestamp(20)).map((alert) => alert.type)).toContain(
      "stale_feed"
    );
    const delayed = oddsUpdate("four", 4, 21, 2.2, 2_000);
    const alertTypes = sentinel.inspect(delayed).alerts.map((alert) => alert.type);
    expect(alertTypes).toContain("delayed_update");
    expect(alertTypes).toContain("feed_recovery");
  });

  it("uses the configured rule weights, threshold, and strategy version", () => {
    const baseConfig = loadConfig({ SENTINEL_MODE: "replay" });
    const config = {
      ...baseConfig,
      strategyConfigurationVersion: "custom-rule-profile-v2",
      thresholds: {
        ...baseConfig.thresholds,
        minRuleBasedConfidenceToTrade: 0.79
      },
      confidenceWeights: {
        base: 0.1,
        absoluteProbabilityShift: 0.2,
        rapidProbabilityShift: 0.3,
        abnormalRelativeToBaseline: 0,
        momentumContinuation: 0,
        confirmedMatchEvent: 0.2,
        lateEventConfirmation: 0,
        unexplainedMovement: 0,
        warningPenalty: 0,
        criticalPenalty: 0,
        minimum: 0,
        maximum: 1
      }
    };
    const engine = new SignalEngine(config);
    const opening = normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 3.2));
    const shifted = normalizeOddsUpdate(oddsUpdate("shift", 2, 10, 1.7));
    expect(engine.process(opening, { fixture, alerts: [] })).toBeUndefined();

    const signal = engine.process(shifted, {
      fixture,
      correlatedEvent: postEventGoal(),
      alerts: []
    });

    expect(signal?.triggeredRules).toEqual(
      expect.arrayContaining([
        "absolute_probability_shift",
        "rapid_probability_shift",
        "confirmed_match_event",
        "event_consistent_movement"
      ])
    );
    expect(signal?.ruleBasedConfidenceScore).toBe(0.8);
    expect(signal?.confidenceComponents).toEqual(
      expect.arrayContaining([
        { component: "base", contribution: 0.1 },
        { component: "confirmed_match_event", contribution: 0.2 }
      ])
    );
    expect(signal?.strategyConfigurationVersion).toBe("custom-rule-profile-v2");
    expect(signal?.paperDecision).toBe("eligible");

    const strictEngine = new SignalEngine({
      ...config,
      thresholds: { ...config.thresholds, minRuleBasedConfidenceToTrade: 0.81 }
    });
    strictEngine.process(opening, { fixture, alerts: [] });
    const belowCustomThreshold = strictEngine.process(shifted, {
      fixture,
      correlatedEvent: postEventGoal(),
      alerts: []
    });
    expect(belowCustomThreshold?.ruleBasedConfidenceScore).toBe(0.8);
    expect(belowCustomThreshold?.paperDecision).toBe("not_eligible");
  });

  it("never makes a falling selection eligible for a long confirmation position", () => {
    const config = loadConfig({ SENTINEL_MODE: "replay" });
    const engine = new SignalEngine(config);
    const opening = normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 1.7));
    const shifted = normalizeOddsUpdate(oddsUpdate("falling-home", 2, 10, 10));
    engine.process(opening, { fixture, alerts: [] });

    const signal = engine.process(shifted, {
      fixture,
      correlatedEvent: postEventGoal(),
      alerts: []
    });

    expect(signal?.selection).toBe("home");
    expect(signal?.movement.probabilityDelta).toBeLessThan(0);
    expect(signal?.triggeredRules).toContain("event_market_divergence");
    expect(signal?.paperDecision).toBe("not_eligible");
  });

  it("does not treat an incompatible positive movement as event confirmation", () => {
    const config = loadConfig({ SENTINEL_MODE: "replay" });
    const engine = new SignalEngine(config);
    const opening = normalizeOddsUpdate(withAwayOdds(oddsUpdate("opening", 1, 0), 6));
    const shifted = normalizeOddsUpdate(withAwayOdds(oddsUpdate("away-rise", 2, 10), 1.5));
    engine.process(opening, { fixture, alerts: [] });

    const signal = engine.process(shifted, {
      fixture,
      correlatedEvent: postEventGoal(),
      alerts: []
    });

    expect(signal?.selection).toBe("away");
    expect(signal?.movement.probabilityDelta).toBeGreaterThan(0);
    expect(signal?.triggeredRules).toContain("event_market_divergence");
    expect(signal?.triggeredRules).not.toContain("confirmed_match_event");
    expect(signal?.paperDecision).toBe("not_eligible");
  });

  it("does not make a retrospectively confirmed movement paper-eligible", () => {
    const config = loadConfig({ SENTINEL_MODE: "replay" });
    const engine = new SignalEngine(config);
    engine.process(normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 3.2)), {
      fixture,
      alerts: []
    });
    const event = matchEvent("late-goal", 1, 8);
    const signal = engine.process(normalizeOddsUpdate(oddsUpdate("shift", 2, 10, 1.7, 3_000)), {
      fixture,
      correlatedEvent: {
        event: { ...event, receivedTimestamp: timestamp(12) },
        relationship: "late_event_confirmation",
        sourceLagMs: 2_000,
        confirmationLeadMs: 1_000
      },
      alerts: []
    });

    expect(signal?.triggeredRules).toContain("late_event_confirmation");
    expect(signal?.triggeredRules).not.toContain("confirmed_match_event");
    expect(signal?.paperDecision).toBe("not_eligible");
  });

  it("uses a directionally supporting goal instead of a nearer unsupported event", () => {
    const engine = new SignalEngine(loadConfig({ SENTINEL_MODE: "replay" }));
    engine.process(normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 3.2)), {
      fixture,
      alerts: []
    });
    const goal = postEventGoal(7);
    const halfTime: CorrelatedEvent = {
      event: {
        ...matchEvent("half-time", 2, 9),
        type: "half_time",
        minute: 45
      },
      relationship: "post_event_reaction",
      sourceLagMs: 1_000,
      confirmationLeadMs: 1_000
    };

    const signal = engine.process(normalizeOddsUpdate(oddsUpdate("shift", 2, 10, 1.7)), {
      fixture,
      correlatedEvents: [halfTime, goal],
      alerts: []
    });

    expect(signal?.correlatedEvent?.event.id).toBe("goal");
    expect(signal?.triggeredRules).toContain("event_consistent_movement");
    expect(signal?.paperDecision).toBe("eligible");
  });

  it("prefers an available post-event reaction over a nearer late confirmation", () => {
    const engine = new SignalEngine(loadConfig({ SENTINEL_MODE: "replay" }));
    engine.process(normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 3.2)), {
      fixture,
      alerts: []
    });
    const availableGoal = postEventGoal(0);
    const lateGoal: CorrelatedEvent = {
      event: {
        ...matchEvent("nearer-late", 2, 9),
        receivedTimestamp: timestamp(11)
      },
      relationship: "late_event_confirmation",
      sourceLagMs: 1_000,
      confirmationLeadMs: 1_000
    };

    const signal = engine.process(
      normalizeOddsUpdate({
        ...oddsUpdate("shift", 2, 10, 1.7),
        receivedTimestamp: timestamp(12)
      }),
      {
        fixture,
        correlatedEvents: [lateGoal, availableGoal],
        alerts: []
      }
    );

    expect(signal?.correlatedEvent?.event.id).toBe("goal");
    expect(signal?.correlatedEvent?.relationship).toBe("post_event_reaction");
    expect(signal?.triggeredRules).toContain("confirmed_match_event");
    expect(signal?.triggeredRules).not.toContain("late_event_confirmation");
    expect(signal?.paperDecision).toBe("eligible");
  });

  it("prioritizes a material positive supported candidate over a larger negative move", () => {
    const engine = new SignalEngine(loadConfig({ SENTINEL_MODE: "replay" }));
    engine.process(normalizeOddsUpdate(fairOddsUpdate("opening", 1, 0, [0.3, 0.3, 0.4])), {
      fixture,
      alerts: []
    });

    const signal = engine.process(
      normalizeOddsUpdate(fairOddsUpdate("shift", 2, 10, [0.36, 0.34, 0.3])),
      { fixture, correlatedEvent: postEventGoal(5), alerts: [] }
    );

    expect(signal?.selection).toBe("home");
    expect(signal?.movement.probabilityDelta).toBeCloseTo(0.06);
    expect(signal?.paperDecision).toBe("eligible");
  });

  it("keeps a supported negative reaction ahead of a larger unsupported move without opening it", () => {
    const engine = new SignalEngine(loadConfig({ SENTINEL_MODE: "replay" }));
    engine.process(normalizeOddsUpdate(fairOddsUpdate("opening", 1, 0, [0.3, 0.3, 0.4])), {
      fixture,
      alerts: []
    });

    const signal = engine.process(
      normalizeOddsUpdate(fairOddsUpdate("shift", 2, 10, [0.22, 0.5, 0.28])),
      { fixture, correlatedEvent: postEventGoal(5), alerts: [] }
    );

    expect(signal?.selection).toBe("away");
    expect(signal?.movement.probabilityDelta).toBeLessThan(0);
    expect(signal?.triggeredRules).toContain("event_consistent_movement");
    expect(signal?.paperDecision).toBe("not_eligible");
  });
});
