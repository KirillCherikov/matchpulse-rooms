import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/domain/models.js";
import { PaperTradingSimulator } from "../../src/engine/paper-trading.js";

const settledAt = "2026-01-01T12:05:00.000Z";

function simulator(
  overrides: Partial<ConstructorParameters<typeof PaperTradingSimulator>[0]> = {}
): PaperTradingSimulator {
  return new PaperTradingSimulator({
    initialVirtualBankroll: 100,
    stakeFraction: 0.1,
    maxExposureFraction: 0.2,
    minRuleBasedConfidenceToTrade: 0.72,
    ...overrides
  });
}

function eligibleSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "signal-001",
    correlationId: "signal:test:001",
    fixtureId: "fixture-001",
    competition: "Test Competition",
    market: "match_winner",
    selection: "home",
    sourceTimestamp: "2026-01-01T12:00:00.000Z",
    receivedTimestamp: "2026-01-01T12:00:00.100Z",
    matchMinute: 42,
    oddsBefore: 2.8,
    oddsAfter: 2.5,
    impliedProbabilityBefore: 1 / 2.8,
    impliedProbabilityAfter: 1 / 2.5,
    normalizedProbabilityBefore: 0.34,
    normalizedProbabilityAfter: 0.4,
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
    latencyMs: 100,
    ruleBasedConfidenceScore: 0.9,
    confidenceComponents: [{ component: "base", contribution: 0.32 }],
    triggeredRules: ["absolute_probability_shift", "confirmed_match_event"],
    explanation: {
      summary: "Test signal",
      dataQuality: "Healthy",
      decision: "Eligible for paper simulation",
      reasons: []
    },
    paperDecision: "eligible",
    strategyConfigurationVersion: "test-v1",
    counterfactual: { horizons: [], immediateEntryOdds: 2.5 },
    ...overrides
  };
}

describe("paper trading regression coverage", () => {
  it("opens at most one position per signal and respects aggregate exposure", () => {
    const paper = simulator();

    expect(paper.openForSignal(eligibleSignal({ id: "signal-1" }))?.stake).toBe(10);
    expect(paper.openForSignal(eligibleSignal({ id: "signal-1" }))).toBeUndefined();
    expect(paper.openForSignal(eligibleSignal({ id: "signal-2" }))?.stake).toBe(10);
    expect(paper.openForSignal(eligibleSignal({ id: "signal-3" }))).toBeUndefined();

    expect(paper.allPositions()).toHaveLength(2);
    expect(paper.analytics([]).openExposure).toBe(20);
  });

  it("does not create a position whose stake rounds to zero", () => {
    const paper = simulator({
      initialVirtualBankroll: 1,
      stakeFraction: 0.004,
      maxExposureFraction: 1
    });

    expect(paper.openForSignal(eligibleSignal())).toBeUndefined();
    expect(paper.allPositions()).toEqual([]);
    expect(paper.analytics([]).openExposure).toBe(0);
  });

  it("rejects an out-of-domain entry price before virtual settlement arithmetic", () => {
    const paper = simulator();

    expect(
      paper.openForSignal(eligibleSignal({ id: "extreme", oddsAfter: Number.MAX_VALUE }))
    ).toBeUndefined();
    expect(paper.allPositions()).toEqual([]);
  });

  it("settles draw and void outcomes and makes repeated settlement idempotent", () => {
    const paper = simulator({ maxExposureFraction: 1 });
    paper.openForSignal(
      eligibleSignal({
        id: "draw-signal",
        fixtureId: "draw-fixture",
        selection: "draw",
        oddsAfter: 3
      })
    );

    const drawSettlement = paper.settle("draw-fixture", "draw", settledAt);
    expect(drawSettlement).toMatchObject([{ outcome: "won", virtualPnl: 20 }]);
    expect(paper.settle("draw-fixture", "draw", settledAt)).toEqual([]);

    paper.openForSignal(eligibleSignal({ id: "void-signal", fixtureId: "void-fixture" }));
    const voidSettlement = paper.settle("void-fixture", "void", settledAt);
    expect(voidSettlement).toMatchObject([{ outcome: "void", virtualPnl: 0 }]);
    expect(paper.settle("void-fixture", "void", settledAt)).toEqual([]);

    const analytics = paper.analytics([]);
    expect(analytics.virtualBankroll).toBe(120);
    expect(analytics.virtualPnl).toBe(20);
    expect(analytics.winRate).toBe(1);
    expect(analytics.averageReturn).toBe(2);
    expect(analytics.settledPositions).toBe(2);
  });

  it("applies same-event settlements atomically so drawdown is order independent", () => {
    const paper = simulator({ stakeFraction: 0.4, maxExposureFraction: 1 });
    paper.openForSignal(
      eligibleSignal({ id: "loss-first", fixtureId: "shared", selection: "home", oddsAfter: 2 })
    );
    paper.openForSignal(
      eligibleSignal({ id: "win-second", fixtureId: "shared", selection: "away", oddsAfter: 2 })
    );

    const settled = paper.settle("shared", "away", settledAt);
    expect(settled.map((position) => position.virtualPnl)).toEqual([-40, 40]);
    expect(paper.analytics([])).toMatchObject({
      virtualBankroll: 100,
      virtualPnl: 0,
      maximumDrawdown: 0,
      maximumDrawdownPercent: 0
    });
  });

  it("preserves historical maximum drawdown percentage after a later equity peak", () => {
    const paper = simulator({ stakeFraction: 0.5, maxExposureFraction: 1 });

    paper.openForSignal(eligibleSignal({ id: "first-win", fixtureId: "first-win", oddsAfter: 3 }));
    paper.settle("first-win", "home", settledAt);

    paper.openForSignal(eligibleSignal({ id: "loss", fixtureId: "loss", oddsAfter: 2 }));
    paper.settle("loss", "away", settledAt);
    expect(paper.analytics([]).maximumDrawdownPercent).toBe(0.5);

    paper.openForSignal(eligibleSignal({ id: "new-peak", fixtureId: "new-peak", oddsAfter: 5 }));
    paper.settle("new-peak", "home", settledAt);

    expect(paper.analytics([])).toMatchObject({
      virtualBankroll: 300,
      maximumDrawdown: 100,
      maximumDrawdownPercent: 0.5
    });
  });

  it("rejects unsafe simulator configuration", () => {
    expect(() => simulator({ initialVirtualBankroll: 0 })).toThrow(/bankroll/i);
    expect(() => simulator({ stakeFraction: 0 })).toThrow(/stake fraction/i);
    expect(() => simulator({ stakeFraction: 1.01 })).toThrow(/stake fraction/i);
    expect(() => simulator({ maxExposureFraction: 0 })).toThrow(/exposure fraction/i);
    expect(() => simulator({ maxExposureFraction: 1.01 })).toThrow(/exposure fraction/i);
  });
});
