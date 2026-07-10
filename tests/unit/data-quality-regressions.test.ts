import { describe, expect, it } from "vitest";
import type { MatchEvent, OddsUpdate } from "../../src/domain/models.js";
import { DataQualitySentinel } from "../../src/engine/data-quality.js";

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
}

function odds(
  id: string,
  sequence: number,
  seconds: number,
  fixtureId = "fixture-001"
): OddsUpdate {
  return {
    kind: "odds",
    id,
    fixtureId,
    market: "match_winner",
    sequence,
    sourceTimestamp: timestamp(seconds),
    receivedTimestamp: timestamp(seconds),
    selections: [
      { selection: "home", decimalOdds: 2.5 },
      { selection: "draw", decimalOdds: 3.4 },
      { selection: "away", decimalOdds: 3.6 }
    ],
    rawReference: `test://odds/${id}`
  };
}

function score(id: string, sequence: number, seconds: number): MatchEvent {
  return {
    kind: "score",
    id,
    fixtureId: "fixture-001",
    sequence,
    sourceTimestamp: timestamp(seconds),
    receivedTimestamp: timestamp(seconds),
    type: "goal",
    minute: 42,
    team: "home",
    score: { home: 1, away: 0 },
    confirmed: true,
    rawReference: `test://score/${id}`
  };
}

function sentinel(seenIdLimitPerFeed = 10): DataQualitySentinel {
  return new DataQualitySentinel({
    staleOddsMs: 10_000,
    staleScoreMs: 10_000,
    delayedUpdateMs: 1_000,
    seenIdLimitPerFeed
  });
}

describe("data-quality sentinel regression coverage", () => {
  it("distinguishes duplicate IDs from duplicate sequences and suppresses repeats", () => {
    const quality = sentinel();
    const first = odds("first", 1, 0);
    expect(quality.inspect(first)).toMatchObject({ shouldProcess: true, alerts: [] });

    const duplicateId = quality.inspect(first);
    expect(duplicateId.shouldProcess).toBe(false);
    expect(duplicateId.alerts[0]).toMatchObject({
      type: "duplicate_update",
      metadata: { duplicateKind: "id" }
    });
    expect(quality.inspect(first).alerts).toEqual([]);

    const duplicateSequence = quality.inspect(odds("same-sequence", 1, 1));
    expect(duplicateSequence.shouldProcess).toBe(false);
    expect(duplicateSequence.alerts[0]).toMatchObject({
      type: "duplicate_update",
      metadata: { duplicateKind: "sequence" }
    });
  });

  it("tracks score and odds sequences independently", () => {
    const quality = sentinel();

    expect(quality.inspect(odds("odds-1", 1, 0)).shouldProcess).toBe(true);
    expect(quality.inspect(score("score-1", 1, 0)).shouldProcess).toBe(true);
    expect(quality.inspect(odds("odds-2", 2, 1)).shouldProcess).toBe(true);
    expect(quality.inspect(score("score-2", 2, 1)).shouldProcess).toBe(true);
  });

  it("rejects a source timestamp later than its receive timestamp", () => {
    const quality = sentinel();
    const invalid = {
      ...odds("future-source", 1, 0),
      sourceTimestamp: timestamp(10),
      receivedTimestamp: timestamp(0)
    };

    const first = quality.inspect(invalid);
    expect(first.shouldProcess).toBe(false);
    expect(first.alerts).toMatchObject([{ type: "invalid_timestamp", severity: "critical" }]);
    expect(quality.inspect(invalid).alerts).toEqual([]);
  });

  it("rejects backward source or receive time even when sequence increases", () => {
    const quality = sentinel();
    expect(quality.inspect(odds("newer", 1, 10)).shouldProcess).toBe(true);

    const backward = quality.inspect(odds("older", 2, 9));
    expect(backward.shouldProcess).toBe(false);
    expect(backward.alerts).toMatchObject([{ type: "out_of_order_update" }]);
  });

  it("rejects higher-sequence odds when neither source nor receive time advances", () => {
    const quality = sentinel();
    expect(quality.inspect(odds("first", 1, 10)).shouldProcess).toBe(true);

    const equalTime = quality.inspect(odds("same-time", 2, 10));
    expect(equalTime.shouldProcess).toBe(false);
    expect(equalTime.alerts).toMatchObject([{ type: "invalid_timestamp", severity: "critical" }]);
  });

  it("suppresses repeated stale alerts, records recovery, and clears state on reset", () => {
    const quality = sentinel();
    expect(quality.inspect(odds("first", 1, 0)).shouldProcess).toBe(true);

    expect(quality.checkStaleness(timestamp(20))).toMatchObject([{ type: "stale_feed" }]);
    expect(quality.checkStaleness(timestamp(21))).toEqual([]);
    expect(quality.hasStaleFeed("fixture-001")).toBe(true);

    const recovery = quality.inspect(odds("recovery", 2, 22));
    expect(recovery.shouldProcess).toBe(true);
    expect(recovery.alerts).toMatchObject([{ type: "feed_recovery" }]);
    expect(quality.hasStaleFeed("fixture-001")).toBe(false);

    quality.reset();
    expect(quality.feedHealth("fixture-001", timestamp(22))).toMatchObject({
      status: "unknown",
      odds: { status: "unknown" },
      score: { status: "unknown" }
    });
    expect(quality.inspect(odds("first", 1, 0)).shouldProcess).toBe(true);
    expect(quality.inspect(odds("first", 1, 0)).alerts).toHaveLength(1);
  });

  it("derives stale feed health from the requested clock even before an alerting tick", () => {
    const quality = sentinel();
    expect(quality.inspect(odds("odds", 1, 0)).shouldProcess).toBe(true);
    expect(quality.inspect(score("score", 1, 0)).shouldProcess).toBe(true);

    expect(quality.feedHealth("fixture-001", timestamp(20))).toMatchObject({
      status: "degraded",
      odds: { status: "stale", ageMs: 20_000 },
      score: { status: "stale", ageMs: 20_000 }
    });
  });

  it("bounds remembered update IDs per feed", () => {
    const quality = sentinel(2);
    expect(quality.inspect(odds("id-1", 1, 0)).shouldProcess).toBe(true);
    expect(quality.inspect(odds("id-2", 2, 1)).shouldProcess).toBe(true);
    expect(quality.inspect(odds("id-3", 3, 2)).shouldProcess).toBe(true);

    // id-1 is outside the bounded memory window, and a monotonic new sequence remains valid.
    expect(quality.inspect(odds("id-1", 4, 3)).shouldProcess).toBe(true);
  });

  it("does not parse fixture IDs from a delimiter-sensitive map key", () => {
    const quality = sentinel();
    expect(quality.inspect(odds("colon", 1, 0, "provider:fixture:42")).shouldProcess).toBe(true);

    expect(quality.checkStaleness(timestamp(20))[0]).toMatchObject({
      fixtureId: "provider:fixture:42",
      feed: "odds"
    });
  });
});
