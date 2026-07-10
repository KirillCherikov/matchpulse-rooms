import { describe, expect, it } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig, type SentinelConfig } from "../../src/config.js";
import type { Fixture, MatchEvent, OddsUpdate, ProviderMessage } from "../../src/domain/models.js";
import { ReplayTxLineProvider } from "../../src/providers/replay.js";

const fixture: Fixture = {
  id: "fixture-lifecycle",
  competition: "Lifecycle Test Competition",
  homeTeam: "Home FC",
  awayTeam: "Away FC",
  status: "live",
  score: { home: 0, away: 0 },
  minute: 40
};

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
}

function odds(id: string, sequence: number, seconds: number, homeOdds: number): OddsUpdate {
  return {
    kind: "odds",
    id,
    fixtureId: fixture.id,
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

function event(
  id: string,
  sequence: number,
  seconds: number,
  overrides: Partial<MatchEvent> = {}
): MatchEvent {
  return {
    kind: "score",
    id,
    fixtureId: fixture.id,
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

function replayAgent(
  messages: ProviderMessage[],
  thresholdOverrides: Partial<SentinelConfig["thresholds"]> = {}
): SentinelAgent {
  const base = loadConfig({ SENTINEL_MODE: "replay" });
  const config: SentinelConfig = {
    ...base,
    mode: "replay",
    thresholds: { ...base.thresholds, ...thresholdOverrides }
  };
  return new SentinelAgent(config, new ReplayTxLineProvider([fixture], messages));
}

function run(agent: SentinelAgent): void {
  agent.startReplay(10);
  while (agent.status().replay?.status !== "finished") {
    agent.advanceReplay();
  }
}

function canonicalState(agent: SentinelAgent): unknown {
  const state = {
    fixtures: agent.fixtures(),
    signals: agent.allSignals(),
    alerts: agent.allAlerts(),
    positions: agent.positions(),
    analytics: agent.analytics()
  };
  return JSON.parse(JSON.stringify(state).replace(/replay-run-\d{4}/g, "replay-run"));
}

describe("replay and simulation lifecycle regressions", () => {
  it("keeps one correlation ID from the triggering input through decision and settlement", () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });
    run(agent);

    const signal = agent.allSignals()[0];
    expect(signal).toBeDefined();
    const chain = agent
      .audit()
      .filter((event) => event.correlationId === signal?.correlationId)
      .map((event) => event.type);
    expect(chain).toEqual(
      expect.arrayContaining([
        "raw_input_reference",
        "normalized_input",
        "signal_decision",
        "paper_execution",
        "counterfactual_evaluation",
        "settlement"
      ])
    );
  });

  it("starts a clean deterministic run after the previous run finished", () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });

    run(agent);
    const first = canonicalState(agent);
    const firstPositionIds = agent.positions().map((position) => position.id);

    run(agent);
    const second = canonicalState(agent);
    const secondPositionIds = agent.positions().map((position) => position.id);

    expect(second).toEqual(first);
    expect(secondPositionIds).not.toEqual(firstPositionIds);

    const executions = agent.audit().filter((auditEvent) => auditEvent.type === "paper_execution");
    expect(new Set(executions.map((auditEvent) => auditEvent.runId))).toEqual(
      new Set(["replay-run-0001", "replay-run-0002"])
    );
    expect(new Set(executions.map((auditEvent) => auditEvent.data.positionId)).size).toBe(
      executions.length
    );
  });

  it("reset clears all dynamic engines and restores the fixture and virtual bankroll", () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });
    agent.startReplay(10);
    for (let index = 0; index < 5; index += 1) agent.advanceReplay();
    expect(agent.allSignals().length).toBeGreaterThan(0);
    expect(agent.positions().length).toBeGreaterThan(0);

    const replay = agent.resetReplay();
    expect(replay).toMatchObject({ status: "idle", speed: 1, cursor: 0 });
    expect(agent.allSignals()).toEqual([]);
    expect(agent.allAlerts()).toEqual([]);
    expect(agent.positions()).toEqual([]);
    expect(agent.fixtures()[0]).toMatchObject({
      status: "scheduled",
      score: { home: 0, away: 0 },
      minute: 0
    });
    expect(agent.analytics()).toMatchObject({
      virtualBankroll: 1_000,
      virtualPnl: 0,
      openExposure: 0,
      settledPositions: 0,
      maximumDrawdown: 0,
      maximumDrawdownPercent: 0
    });
  });

  it("does not open a position while a correlated score feed remains stale", () => {
    const agent = replayAgent(
      [
        event("goal", 1, 0),
        odds("baseline", 1, 0, 2.8),
        odds("flat", 2, 2, 2.8),
        odds("shift", 3, 3, 1.45)
      ],
      {
        staleScoreMs: 1_000,
        staleOddsMs: 100_000,
        correlationWindowMs: 10_000
      }
    );

    run(agent);

    expect(agent.allAlerts().map((alert) => alert.type)).toContain("stale_feed");
    expect(agent.allSignals()).toHaveLength(1);
    expect(agent.allSignals()[0]).toMatchObject({
      paperDecision: "not_eligible",
      triggeredRules: expect.arrayContaining(["data_quality_warning"])
    });
    expect(agent.positions()).toEqual([]);
  });

  it("does not settle from unconfirmed full time", () => {
    const agent = replayAgent([
      odds("baseline", 1, 0, 2.8),
      event("goal", 1, 1),
      odds("shift", 2, 2, 1.45),
      event("unconfirmed-full-time", 2, 3, {
        type: "full_time",
        minute: 90,
        confirmed: false
      })
    ]);

    run(agent);

    expect(agent.positions()).toHaveLength(1);
    expect(agent.positions()[0]?.status).toBe("open");
    expect(agent.positions()[0]?.outcome).toBeUndefined();
    expect(agent.allSignals()[0]?.outcome).toBeUndefined();
    expect(agent.audit().filter((auditEvent) => auditEvent.type === "settlement")).toEqual([]);
  });

  it("voids an open position when a confirmed fixture cancellation arrives", () => {
    const agent = replayAgent([
      odds("baseline", 1, 0, 2.8),
      event("goal", 1, 1),
      odds("shift", 2, 2, 1.45),
      event("cancelled", 2, 3, {
        type: "cancelled",
        minute: 43
      })
    ]);

    run(agent);

    expect(agent.positions()).toMatchObject([
      { status: "settled", outcome: "void", virtualPnl: 0 }
    ]);
    expect(agent.analytics()).toMatchObject({ virtualPnl: 0, openExposure: 0, winRate: 0 });
    expect(agent.allSignals()[0]?.outcome).toMatchObject({
      positionOutcome: "void",
      virtualPnl: 0
    });
  });

  it("does not treat a flat odds heartbeat as a reaction to a confirmed goal", () => {
    const agent = replayAgent(
      [
        odds("baseline", 1, 0, 2.8),
        event("goal", 1, 1),
        odds("flat", 2, 2, 2.8),
        odds("after-window", 3, 5, 2.8)
      ],
      {
        correlationWindowMs: 3_000,
        staleOddsMs: 100_000,
        staleScoreMs: 100_000
      }
    );

    run(agent);

    expect(agent.allAlerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "odds_score_divergence",
          feed: "score",
          metadata: expect.objectContaining({ eventId: "goal" })
        })
      ])
    );
  });
});
