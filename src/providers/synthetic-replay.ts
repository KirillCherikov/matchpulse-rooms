import type { Fixture, ProviderMessage } from "../domain/models.js";
import { SYNTHETIC_DEMO_LABEL } from "../domain/models.js";

const fixtureId = "synthetic-world-cup-demo-001";
const iso = (seconds: number): string =>
  new Date(Date.UTC(2026, 5, 14, 12, 0, seconds)).toISOString();

export function createSyntheticFixture(): Fixture {
  return {
    id: fixtureId,
    competition: "Synthetic World Cup Replay",
    homeTeam: "Northport FC",
    awayTeam: "Southbank United",
    status: "scheduled",
    score: { home: 0, away: 0 },
    minute: 0,
    dataLabel: SYNTHETIC_DEMO_LABEL
  };
}

export function createSyntheticReplayMessages(): ProviderMessage[] {
  return [
    {
      kind: "score",
      id: "score-kickoff-001",
      fixtureId,
      sequence: 1,
      sourceTimestamp: iso(0),
      receivedTimestamp: iso(0),
      type: "kickoff",
      minute: 0,
      confirmed: true,
      rawReference: "synthetic://score/kickoff-001"
    },
    {
      kind: "odds",
      id: "odds-opening-001",
      fixtureId,
      market: "match_winner",
      sequence: 1,
      sourceTimestamp: iso(2),
      receivedTimestamp: iso(2),
      selections: [
        { selection: "home", decimalOdds: 2.64 },
        { selection: "draw", decimalOdds: 3.36 },
        { selection: "away", decimalOdds: 3.08 }
      ],
      rawReference: "synthetic://odds/opening-001"
    },
    {
      kind: "odds",
      id: "odds-baseline-002",
      fixtureId,
      market: "match_winner",
      sequence: 2,
      sourceTimestamp: iso(20),
      receivedTimestamp: iso(20),
      selections: [
        { selection: "home", decimalOdds: 2.59 },
        { selection: "draw", decimalOdds: 3.38 },
        { selection: "away", decimalOdds: 3.12 }
      ],
      rawReference: "synthetic://odds/baseline-002"
    },
    {
      kind: "score",
      id: "score-goal-002",
      fixtureId,
      sequence: 2,
      sourceTimestamp: iso(60),
      receivedTimestamp: iso(60),
      type: "goal",
      minute: 63,
      team: "home",
      score: { home: 1, away: 0 },
      confirmed: true,
      rawReference: "synthetic://score/goal-002"
    },
    {
      kind: "odds",
      id: "odds-goal-shift-003",
      fixtureId,
      market: "match_winner",
      sequence: 3,
      sourceTimestamp: iso(72),
      receivedTimestamp: iso(73),
      selections: [
        { selection: "home", decimalOdds: 1.78 },
        { selection: "draw", decimalOdds: 4.5 },
        { selection: "away", decimalOdds: 6.2 }
      ],
      rawReference: "synthetic://odds/goal-shift-003"
    },
    {
      kind: "odds",
      id: "odds-goal-shift-003",
      fixtureId,
      market: "match_winner",
      sequence: 3,
      sourceTimestamp: iso(72),
      receivedTimestamp: iso(75),
      selections: [
        { selection: "home", decimalOdds: 1.78 },
        { selection: "draw", decimalOdds: 4.5 },
        { selection: "away", decimalOdds: 6.2 }
      ],
      rawReference: "synthetic://odds/goal-shift-duplicate"
    },
    {
      kind: "odds",
      id: "odds-horizon-030-004",
      fixtureId,
      market: "match_winner",
      sequence: 4,
      sourceTimestamp: iso(102),
      receivedTimestamp: iso(102),
      selections: [
        { selection: "home", decimalOdds: 1.76 },
        { selection: "draw", decimalOdds: 4.6 },
        { selection: "away", decimalOdds: 6.35 }
      ],
      rawReference: "synthetic://odds/horizon-030-004"
    },
    {
      kind: "odds",
      id: "odds-recovery-gap-005",
      fixtureId,
      market: "match_winner",
      sequence: 6,
      sourceTimestamp: iso(150),
      receivedTimestamp: iso(150),
      selections: [
        { selection: "home", decimalOdds: 1.72 },
        { selection: "draw", decimalOdds: 4.9 },
        { selection: "away", decimalOdds: 6.9 }
      ],
      rawReference: "synthetic://odds/recovery-gap-005"
    },
    {
      kind: "odds",
      id: "odds-out-of-order-004",
      fixtureId,
      market: "match_winner",
      sequence: 5,
      sourceTimestamp: iso(155),
      receivedTimestamp: iso(155),
      selections: [
        { selection: "home", decimalOdds: 1.73 },
        { selection: "draw", decimalOdds: 4.8 },
        { selection: "away", decimalOdds: 6.8 }
      ],
      rawReference: "synthetic://odds/out-of-order-004"
    },
    {
      kind: "score",
      id: "score-var-delayed-003",
      fixtureId,
      sequence: 3,
      sourceTimestamp: iso(96),
      receivedTimestamp: iso(160),
      type: "var",
      minute: 66,
      confirmed: true,
      rawReference: "synthetic://score/var-delayed-003"
    },
    {
      kind: "odds",
      id: "odds-confirmation-006",
      fixtureId,
      market: "match_winner",
      sequence: 7,
      sourceTimestamp: iso(190),
      receivedTimestamp: iso(190),
      selections: [
        { selection: "home", decimalOdds: 1.68 },
        { selection: "draw", decimalOdds: 5.1 },
        { selection: "away", decimalOdds: 7.2 }
      ],
      rawReference: "synthetic://odds/confirmation-006"
    },
    {
      kind: "odds",
      id: "odds-long-horizon-007",
      fixtureId,
      market: "match_winner",
      sequence: 8,
      sourceTimestamp: iso(372),
      receivedTimestamp: iso(372),
      selections: [
        { selection: "home", decimalOdds: 1.68 },
        { selection: "draw", decimalOdds: 5.1 },
        { selection: "away", decimalOdds: 7.2 }
      ],
      rawReference: "synthetic://odds/long-horizon-007"
    },
    {
      kind: "score",
      id: "score-full-time-004",
      fixtureId,
      sequence: 4,
      sourceTimestamp: iso(420),
      receivedTimestamp: iso(420),
      type: "full_time",
      minute: 90,
      score: { home: 1, away: 0 },
      confirmed: true,
      rawReference: "synthetic://score/full-time-004"
    }
  ];
}
