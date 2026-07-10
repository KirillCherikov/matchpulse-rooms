import { describe, expect, it } from "vitest";
import type { Fixture, OddsUpdate } from "../../src/domain/models.js";
import { ReplayTxLineProvider } from "../../src/providers/replay.js";

const fixture: Fixture = {
  id: "fixture-replay",
  competition: "Replay Test",
  homeTeam: "Home",
  awayTeam: "Away",
  status: "scheduled",
  score: { home: 0, away: 0 },
  minute: 0
};

function update(id: string, sequence: number, seconds: number): OddsUpdate {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
  return {
    kind: "odds",
    id,
    fixtureId: fixture.id,
    market: "match_winner",
    sequence,
    sourceTimestamp: timestamp,
    receivedTimestamp: timestamp,
    selections: [
      { selection: "home", decimalOdds: 2.5 },
      { selection: "draw", decimalOdds: 3.4 },
      { selection: "away", decimalOdds: 3.6 }
    ],
    rawReference: `test://replay/${id}`
  };
}

describe("deterministic replay provider regressions", () => {
  it("rejects input that would move the simulated receive clock backward", () => {
    expect(
      () => new ReplayTxLineProvider([fixture], [update("later", 1, 10), update("earlier", 2, 5)])
    ).toThrow(/nondecreasing received timestamp/i);
  });

  it("keeps explicit pause/resume state and performs a complete reset", () => {
    const replay = new ReplayTxLineProvider(
      [fixture],
      [update("first", 1, 0), update("second", 2, 1)]
    );

    expect(replay.start(5)).toMatchObject({ status: "running", speed: 5, cursor: 0 });
    expect(replay.advance()?.id).toBe("first");
    expect(replay.pause()).toMatchObject({ status: "paused", speed: 5, cursor: 1 });
    expect(replay.resume()).toMatchObject({ status: "running", speed: 5, cursor: 1 });
    expect(replay.reset()).toEqual({
      status: "idle",
      speed: 1,
      cursor: 0,
      totalEvents: 2
    });
  });

  it("honors the requested speed when restarted after completion", () => {
    const replay = new ReplayTxLineProvider([fixture], [update("only", 1, 0)]);
    replay.start(1);
    replay.advance();
    expect(replay.getReplayState().status).toBe("finished");

    expect(replay.start(10)).toMatchObject({ status: "running", speed: 10, cursor: 0 });
  });
});
