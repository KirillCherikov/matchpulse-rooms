import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { EventCorrelator } from "../../src/engine/correlation.js";
import { DataQualitySentinel } from "../../src/engine/data-quality.js";
import { normalizeOddsUpdate } from "../../src/engine/odds.js";
import { SignalEngine } from "../../src/engine/signal-engine.js";
import { fixture, matchEvent, oddsUpdate, timestamp } from "../helpers.js";

describe("event correlation and signal detection", () => {
  it("correlates only confirmed events inside the configured time window", () => {
    const correlator = new EventCorrelator(30_000);
    const event = matchEvent("goal", 1, 30);
    correlator.record(event);
    expect(correlator.correlate(fixture.id, timestamp(50))?.event.id).toBe("goal");
    expect(correlator.correlate(fixture.id, timestamp(70))).toBeUndefined();
  });

  it("detects duplicate, gap, out-of-order, stale, delayed, and recovery conditions", () => {
    const sentinel = new DataQualitySentinel({
      staleOddsMs: 10_000,
      staleScoreMs: 10_000,
      delayedUpdateMs: 1_000
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

  it("creates a high-confidence event-confirmed signal only after threshold movement", () => {
    const config = loadConfig({ SENTINEL_MODE: "replay" });
    const engine = new SignalEngine(config);
    const opening = normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 3.2));
    const shifted = normalizeOddsUpdate(oddsUpdate("shift", 2, 10, 1.7));
    expect(engine.process(opening, { fixture, alerts: [] })).toBeUndefined();
    const event = matchEvent("goal", 1, 8);
    const signal = engine.process(shifted, {
      fixture,
      correlatedEvent: { event, distanceMs: 2_000 },
      alerts: []
    });
    expect(signal?.triggeredRules).toContain("confirmed_match_event");
    expect(signal?.confidence).toBeGreaterThanOrEqual(config.thresholds.minConfidenceToTrade);
    expect(signal?.paperDecision).toBe("opened");
  });
});
