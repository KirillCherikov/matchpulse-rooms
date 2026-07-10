import { describe, expect, it } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig, type SentinelConfig } from "../../src/config.js";
import type { Fixture, MatchEvent, OddsUpdate, ProviderMessage } from "../../src/domain/models.js";
import { providerMessageSchema } from "../../src/domain/schemas.js";
import { ReplayTxLineProvider } from "../../src/providers/replay.js";

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
}

function fixture(id: string): Fixture {
  return {
    id,
    competition: "Core Hardening Test",
    homeTeam: `${id} Home`,
    awayTeam: `${id} Away`,
    status: "live",
    score: { home: 0, away: 0 },
    minute: 1
  };
}

function odds(
  fixtureId: string,
  id: string,
  sequence: number,
  seconds: number,
  homeOdds = 2.8
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
      { selection: "home", decimalOdds: homeOdds },
      { selection: "draw", decimalOdds: 3.4 },
      { selection: "away", decimalOdds: 3.6 }
    ],
    rawReference: `test://odds/${id}`
  };
}

function fairOdds(
  fixtureId: string,
  id: string,
  sequence: number,
  seconds: number,
  probabilities: [number, number, number]
): OddsUpdate {
  return {
    ...odds(fixtureId, id, sequence, seconds),
    selections: [
      { selection: "home", decimalOdds: 1 / probabilities[0] },
      { selection: "draw", decimalOdds: 1 / probabilities[1] },
      { selection: "away", decimalOdds: 1 / probabilities[2] }
    ]
  };
}

function score(
  fixtureId: string,
  id: string,
  sequence: number,
  seconds: number,
  overrides: Partial<MatchEvent> = {}
): MatchEvent {
  return {
    kind: "score",
    id,
    fixtureId,
    sequence,
    sourceTimestamp: timestamp(seconds),
    receivedTimestamp: timestamp(seconds),
    type: "goal",
    minute: 42,
    team: "home",
    score: { home: 1, away: 0 },
    confirmed: true,
    rawReference: `test://score/${id}`,
    ...overrides
  };
}

function agent(
  fixtures: Fixture[],
  messages: ProviderMessage[],
  thresholdOverrides: Partial<SentinelConfig["thresholds"]> = {},
  options: { auditEventLimit?: number } = {}
): SentinelAgent {
  const base = loadConfig({ SENTINEL_MODE: "replay" });
  const config: SentinelConfig = {
    ...base,
    mode: "replay",
    thresholds: { ...base.thresholds, ...thresholdOverrides }
  };
  return new SentinelAgent(config, new ReplayTxLineProvider(fixtures, messages), options);
}

function run(current: SentinelAgent): void {
  current.startReplay(10);
  while (current.status().replay?.status !== "finished") current.advanceReplay();
}

describe("core hardening integration regressions", () => {
  it("rejects multi-fixture stale and divergence fan-out before any partial mutation", () => {
    const fixtures = Array.from({ length: 33 }, (_, index) => fixture(`fanout-${index}`));
    const messages: ProviderMessage[] = [
      ...fixtures.map((match, index) => score(match.id, `goal-${index}`, 1, 0)),
      odds(fixtures[0]!.id, "fanout-trigger", 1, 100)
    ];
    const current = agent(
      fixtures,
      messages,
      { staleOddsMs: 1_000, staleScoreMs: 1_000, correlationWindowMs: 1_000 },
      { auditEventLimit: 200 }
    );
    current.startReplay();
    for (let index = 0; index < fixtures.length; index += 1) current.advanceReplay();
    for (let index = 0; index < 33; index += 1) {
      current.pauseReplay();
      current.resumeReplay();
    }

    const before = {
      replay: current.status().replay,
      feedHealth: current.status().feedHealth,
      fixtures: current.fixtures(),
      alerts: current.allAlerts(),
      audit: current.audit()
    };
    expect(before.audit).toHaveLength(133);

    expect(() => current.advanceReplay()).toThrow(
      "Audit capacity is too low to process another replay action safely"
    );
    expect({
      replay: current.status().replay,
      feedHealth: current.status().feedHealth,
      fixtures: current.fixtures(),
      alerts: current.allAlerts(),
      audit: current.audit()
    }).toEqual(before);
  });

  it("rejects a confirmed full-time event without a final score at the schema boundary", () => {
    const missingScore = {
      kind: "score",
      id: "full-time-without-score",
      fixtureId: "fixture-a",
      sequence: 1,
      sourceTimestamp: timestamp(90),
      receivedTimestamp: timestamp(90),
      type: "full_time",
      minute: 90,
      confirmed: true,
      rawReference: "test://score/full-time-without-score"
    };

    const parsed = providerMessageSchema.safeParse(missingScore);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["score"],
            message: "A confirmed full-time event must include the final score"
          })
        ])
      );
    }
  });

  it("freezes every fixture and simulation field after the first confirmed terminal event", () => {
    const match = fixture("terminal-fixture");
    const current = agent(
      [match],
      [
        odds(match.id, "baseline", 1, 0),
        score(match.id, "goal", 1, 1),
        odds(match.id, "shift", 2, 2, 1.45),
        score(match.id, "full-time", 2, 3, {
          type: "full_time",
          minute: 90,
          score: { home: 1, away: 0 }
        }),
        odds(match.id, "post-terminal-odds", 3, 4, 3.2),
        score(match.id, "repeated-full-time", 3, 5, {
          type: "full_time",
          minute: 90,
          score: { home: 1, away: 0 }
        }),
        score(match.id, "conflicting-full-time", 4, 6, {
          type: "full_time",
          minute: 91,
          score: { home: 1, away: 2 }
        }),
        score(match.id, "post-terminal-goal", 5, 7, {
          minute: 92,
          team: "away",
          score: { home: 1, away: 2 }
        }),
        score(match.id, "unconfirmed-after-terminal", 6, 8, {
          minute: 93,
          confirmed: false,
          team: "away",
          score: { home: 1, away: 2 }
        })
      ]
    );
    current.startReplay();
    for (let index = 0; index < 4; index += 1) current.advanceReplay();
    const terminalState = {
      fixture: current.fixtures()[0],
      signals: current.allSignals(),
      positions: current.positions(),
      analytics: current.analytics(),
      latestEvent: current.status().latestEvent,
      latestConfirmedEvent: current.status().latestConfirmedEvent,
      latestOdds: current.status().latestOdds,
      oddsLastReceivedTimestamp: current.status().feedHealth.odds.lastReceivedTimestamp
    };

    while (current.status().replay?.status !== "finished") current.advanceReplay();

    expect({
      fixture: current.fixtures()[0],
      signals: current.allSignals(),
      positions: current.positions(),
      analytics: current.analytics(),
      latestEvent: current.status().latestEvent,
      latestConfirmedEvent: current.status().latestConfirmedEvent,
      latestOdds: current.status().latestOdds,
      oddsLastReceivedTimestamp: current.status().feedHealth.odds.lastReceivedTimestamp
    }).toEqual(terminalState);
    expect(
      current.allAlerts().filter((alert) => alert.type === "terminal_event_rejected")
    ).toMatchObject([
      { severity: "warning", metadata: { classification: "duplicate" } },
      { severity: "critical", metadata: { classification: "conflict" } },
      { severity: "critical", metadata: { classification: "conflict" } }
    ]);
    for (const rejectedId of [
      "post-terminal-odds",
      "repeated-full-time",
      "conflicting-full-time",
      "post-terminal-goal",
      "unconfirmed-after-terminal"
    ]) {
      expect(
        current
          .audit()
          .find(
            (event) =>
              event.type === "normalized_input" &&
              event.correlationId.endsWith(`:input:${rejectedId}`)
          )
      ).toMatchObject({ data: { authoritative: false } });
    }
  });

  it("keeps pending score reactions distinct when provider event IDs repeat across fixtures", () => {
    const first = fixture("fixture-a");
    const second = fixture("fixture-b");
    const current = agent(
      [first, second],
      [
        score(first.id, "shared-event-id", 1, 0),
        score(second.id, "shared-event-id", 1, 0),
        odds(first.id, "odds-a", 1, 100),
        odds(second.id, "odds-b", 1, 100)
      ],
      { correlationWindowMs: 1_000, staleOddsMs: 200_000, staleScoreMs: 200_000 }
    );

    run(current);

    const divergences = current
      .allAlerts()
      .filter((alert) => alert.type === "odds_score_divergence" && alert.feed === "score");
    expect(divergences.map((alert) => alert.fixtureId).sort()).toEqual([first.id, second.id]);
    expect(divergences.map((alert) => alert.metadata.eventId)).toEqual([
      "shared-event-id",
      "shared-event-id"
    ]);
    expect(new Set(divergences.map((alert) => alert.correlationId)).size).toBe(2);
  });

  it("does not penalize a healthy fixture signal for another fixture's stale feed", () => {
    const stale = fixture("stale-fixture");
    const healthy = fixture("healthy-fixture");
    const current = agent(
      [stale, healthy],
      [
        odds(stale.id, "stale-baseline", 1, 0),
        odds(healthy.id, "healthy-baseline", 1, 4),
        score(healthy.id, "healthy-goal", 1, 5),
        odds(healthy.id, "healthy-shift", 2, 6, 1.45)
      ],
      { staleOddsMs: 5_000, staleScoreMs: 100_000, correlationWindowMs: 10_000 }
    );

    run(current);

    expect(current.allAlerts()).toEqual(
      expect.arrayContaining([expect.objectContaining({ fixtureId: stale.id, type: "stale_feed" })])
    );
    expect(current.allSignals()[0]).toMatchObject({
      fixtureId: healthy.id,
      paperDecision: "opened"
    });
    expect(current.allSignals()[0]?.triggeredRules).not.toContain("data_quality_warning");
    expect(current.positions()).toHaveLength(1);
  });

  it("keeps a late-confirmed event pending until a post-confirmation reaction arrives", () => {
    const match = fixture("late-confirmation");
    const delayedGoal = score(match.id, "delayed-goal", 1, 8, {
      receivedTimestamp: timestamp(12)
    });
    const shifted = {
      ...odds(match.id, "retrospective-shift", 2, 10, 1.45),
      receivedTimestamp: timestamp(13)
    };
    const current = agent(
      [match],
      [
        odds(match.id, "baseline", 1, 0),
        delayedGoal,
        shifted,
        odds(match.id, "after-window", 3, 60, 1.45)
      ],
      { correlationWindowMs: 30_000, staleOddsMs: 100_000, staleScoreMs: 100_000 }
    );

    run(current);

    expect(current.allSignals()[0]).toMatchObject({
      paperDecision: "not_eligible",
      correlatedEvent: { relationship: "late_event_confirmation" },
      triggeredRules: expect.arrayContaining([
        "late_event_confirmation",
        "event_consistent_movement"
      ])
    });
    expect(current.positions()).toEqual([]);
    expect(current.allAlerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "odds_score_divergence",
          feed: "score",
          metadata: expect.objectContaining({ eventId: delayedGoal.id })
        })
      ])
    );
  });

  it("accepts a supported negative post-event reaction without making it paper-eligible", () => {
    const match = fixture("negative-reaction");
    const current = agent(
      [match],
      [
        fairOdds(match.id, "baseline", 1, 0, [0.3, 0.3, 0.4]),
        score(match.id, "goal", 1, 1),
        fairOdds(match.id, "negative-shift", 2, 2, [0.22, 0.5, 0.28]),
        fairOdds(match.id, "after-window", 3, 50, [0.22, 0.5, 0.28])
      ],
      { correlationWindowMs: 10_000, staleOddsMs: 100_000, staleScoreMs: 100_000 }
    );

    run(current);

    expect(current.allSignals()[0]).toMatchObject({
      selection: "away",
      paperDecision: "not_eligible",
      triggeredRules: expect.arrayContaining(["event_consistent_movement"])
    });
    expect(current.positions()).toEqual([]);
    expect(
      current
        .allAlerts()
        .some(
          (alert) => alert.type === "odds_score_divergence" && alert.metadata.eventId === "goal"
        )
    ).toBe(false);
  });
});
