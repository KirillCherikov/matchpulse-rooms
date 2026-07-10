import type { Fixture, MatchEvent, OddsUpdate, Signal } from "../src/domain/models.js";

export const fixture: Fixture = {
  id: "fixture-test",
  competition: "Test Competition",
  homeTeam: "Home FC",
  awayTeam: "Away FC",
  status: "live",
  score: { home: 0, away: 0 },
  minute: 42
};

export function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
}

export function oddsUpdate(
  id: string,
  sequence: number,
  seconds: number,
  homeOdds = 2.5,
  receivedOffsetMs = 0
): OddsUpdate {
  return {
    kind: "odds",
    id,
    fixtureId: fixture.id,
    market: "match_winner",
    sequence,
    sourceTimestamp: timestamp(seconds),
    receivedTimestamp: new Date(
      new Date(timestamp(seconds)).getTime() + receivedOffsetMs
    ).toISOString(),
    selections: [
      { selection: "home", decimalOdds: homeOdds },
      { selection: "draw", decimalOdds: 3.4 },
      { selection: "away", decimalOdds: 3.6 }
    ],
    rawReference: `test://odds/${id}`
  };
}

export function matchEvent(id: string, sequence: number, seconds: number): MatchEvent {
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
    rawReference: `test://score/${id}`
  };
}

export function paperEligibleSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "signal-test-001",
    correlationId: "signal:test",
    fixtureId: fixture.id,
    competition: fixture.competition,
    market: "match_winner",
    selection: "home",
    sourceTimestamp: timestamp(10),
    receivedTimestamp: timestamp(10),
    matchMinute: 42,
    oddsBefore: 2.6,
    oddsAfter: 2.5,
    impliedProbabilityBefore: 1 / 2.6,
    impliedProbabilityAfter: 0.4,
    normalizedProbabilityBefore: 0.36,
    normalizedProbabilityAfter: 0.42,
    latencyMs: 0,
    movement: {
      probabilityDelta: 0.06,
      percentagePointMovement: 6,
      velocityPerSecond: 0.006,
      accelerationPerSecondSquared: 0.0006,
      rollingBaseline: {
        sampleSize: 3,
        meanAbsoluteMovement: 0.01,
        standardDeviation: 0.002,
        volatility: 0.002
      }
    },
    ruleBasedConfidenceScore: 0.9,
    confidenceComponents: [
      { component: "base", contribution: 0.32 },
      { component: "confirmed_match_event", contribution: 0.22 }
    ],
    triggeredRules: [
      "absolute_probability_shift",
      "confirmed_match_event",
      "event_consistent_movement"
    ],
    explanation: { summary: "Test", dataQuality: "Clear", decision: "Open", reasons: [] },
    paperDecision: "eligible",
    strategyConfigurationVersion: "test",
    counterfactual: { horizons: [], immediateEntryOdds: 2.5 },
    ...overrides
  };
}
