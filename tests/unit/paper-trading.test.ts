import { describe, expect, it } from "vitest";
import type { NormalizedOddsSnapshot, Signal } from "../../src/domain/models.js";
import { updateCounterfactuals } from "../../src/engine/counterfactual.js";
import { normalizeOddsUpdate } from "../../src/engine/odds.js";
import { PaperTradingSimulator } from "../../src/engine/paper-trading.js";
import { oddsUpdate, paperEligibleSignal, timestamp } from "../helpers.js";

const counterfactualThresholds = {
  persistenceRatio: 0.6,
  reversalRatio: 0,
  maxObservationLagSeconds: 5
};

function counterfactualSignal(): Signal {
  const base = paperEligibleSignal();
  return {
    ...base,
    sourceTimestamp: timestamp(0),
    receivedTimestamp: timestamp(0),
    normalizedProbabilityBefore: 0.4,
    normalizedProbabilityAfter: 0.5,
    movement: {
      ...base.movement,
      probabilityDelta: 0.1,
      percentagePointMovement: 10
    },
    counterfactual: { horizons: [], immediateEntryOdds: 2 }
  };
}

function fairSnapshot(
  id: string,
  sequence: number,
  seconds: number,
  homeProbability: number
): NormalizedOddsSnapshot {
  const otherProbability = (1 - homeProbability) / 2;
  return normalizeOddsUpdate({
    ...oddsUpdate(id, sequence, seconds),
    selections: [
      { selection: "home", decimalOdds: 1 / homeProbability },
      { selection: "draw", decimalOdds: 1 / otherProbability },
      { selection: "away", decimalOdds: 1 / otherProbability }
    ]
  });
}

function evaluateCounterfactual(signal: Signal, snapshot: NormalizedOddsSnapshot): Signal {
  const evaluated = updateCounterfactuals([signal], snapshot, counterfactualThresholds)[0];
  if (!evaluated) throw new Error("Expected one counterfactual signal result");
  return evaluated;
}

describe("paper trading simulation", () => {
  it("opens a capped paper position and settles virtual P&L", () => {
    const simulator = new PaperTradingSimulator({
      initialVirtualBankroll: 100,
      stakeFraction: 0.2,
      maxExposureFraction: 0.1,
      minRuleBasedConfidenceToTrade: 0.72
    });
    const position = simulator.openForSignal(paperEligibleSignal());
    expect(position?.stake).toBe(10);
    const settled = simulator.settle("fixture-test", "home", "2026-01-01T12:02:00.000Z");
    expect(settled[0]?.outcome).toBe("won");
    expect(settled[0]?.virtualPnl).toBe(15);
    expect(simulator.analytics([paperEligibleSignal()]).virtualPnl).toBe(15);
  });

  it("calculates drawdown after a virtual loss", () => {
    const simulator = new PaperTradingSimulator({
      initialVirtualBankroll: 100,
      stakeFraction: 0.1,
      maxExposureFraction: 0.1,
      minRuleBasedConfidenceToTrade: 0.72
    });
    simulator.openForSignal(paperEligibleSignal({ fixtureId: "loss-fixture", id: "loss" }));
    simulator.settle("loss-fixture", "away", "2026-01-01T12:02:00.000Z");
    const analytics = simulator.analytics([]);
    expect(analytics.virtualPnl).toBe(-10);
    expect(analytics.maximumDrawdown).toBe(10);
  });

  it("classifies retained movement independently at 30, 60, and 300 seconds", () => {
    let signal = counterfactualSignal();
    signal = evaluateCounterfactual(signal, fairSnapshot("thirty", 2, 31, 0.5));
    signal = evaluateCounterfactual(signal, fairSnapshot("sixty", 3, 61, 0.45));
    signal = evaluateCounterfactual(signal, fairSnapshot("five-minutes", 4, 301, 0.39));

    expect(signal.counterfactual.horizons.map((point) => point.horizonSeconds)).toEqual([
      30, 60, 300
    ]);
    expect(signal.counterfactual.horizons.map((point) => point.classification)).toEqual([
      "persisted",
      "inconclusive",
      "reversed"
    ]);
    expect(signal.counterfactual.horizons.map((point) => point.observationLagSeconds)).toEqual([
      1, 1, 1
    ]);
    expect(signal.counterfactual.horizons[0]?.retainedMovementRatio).toBeCloseTo(1);
    expect(signal.counterfactual.horizons[1]?.retainedMovementRatio).toBeCloseTo(0.5);
    expect(signal.counterfactual.horizons[2]?.retainedMovementRatio).toBeCloseTo(-0.1);
    expect(signal.counterfactual.movementAssessment).toBe("inconclusive");
  });

  it("keeps a stable move and a small retracement classified as persisted", () => {
    const stable = updateCounterfactuals(
      [counterfactualSignal()],
      fairSnapshot("stable", 2, 61, 0.5),
      counterfactualThresholds
    )[0];
    const retraced = updateCounterfactuals(
      [counterfactualSignal()],
      fairSnapshot("small-retracement", 2, 61, 0.495),
      counterfactualThresholds
    )[0];

    expect(stable?.counterfactual.horizons.map((point) => point.classification)).toEqual([
      "persisted"
    ]);
    expect(retraced?.counterfactual.horizons.map((point) => point.classification)).toEqual([
      "persisted"
    ]);
    expect(retraced?.counterfactual.horizons[0]?.retainedMovementRatio).toBeCloseTo(0.95);
  });

  it("does not evaluate a horizon from a snapshot unavailable after the decision", () => {
    const signal = counterfactualSignal();
    const snapshot = {
      ...fairSnapshot("not-yet-received", 2, 61, 0.5),
      receivedTimestamp: timestamp(0)
    };

    expect(
      updateCounterfactuals([signal], snapshot, counterfactualThresholds)[0]?.counterfactual
        .horizons
    ).toEqual([]);
  });

  it("does not backfill an expired horizon from a much later observation", () => {
    const evaluated = evaluateCounterfactual(
      counterfactualSignal(),
      fairSnapshot("late-observation", 2, 100, 0.5)
    );

    expect(evaluated.counterfactual.horizons).toEqual([]);
    expect(evaluated.counterfactual.confirmationEntryOdds).toBeUndefined();
    expect(evaluated.counterfactual.confirmationDelaySeconds).toBeUndefined();
  });

  it("does not backfill confirmation from an on-time source observation received too late", () => {
    const delayedReceipt = {
      ...fairSnapshot("delayed-receipt", 2, 31, 0.55),
      receivedTimestamp: timestamp(100)
    };
    const evaluated = evaluateCounterfactual(counterfactualSignal(), delayedReceipt);

    expect(evaluated.counterfactual.horizons).toEqual([]);
    expect(evaluated.counterfactual.confirmationEntryOdds).toBeUndefined();
    expect(evaluated.counterfactual.confirmationDelaySeconds).toBeUndefined();
  });

  it("records confirmation entry from the first admissible 30-second observation", () => {
    const confirmationSnapshot = {
      ...fairSnapshot("confirmation", 2, 31, 0.55),
      receivedTimestamp: timestamp(33)
    };
    const evaluated = evaluateCounterfactual(counterfactualSignal(), confirmationSnapshot);

    expect(evaluated.counterfactual.confirmationEntryOdds).toBeCloseTo(1 / 0.55);
    expect(evaluated.counterfactual.confirmationDelaySeconds).toBe(33);
    expect(evaluated.counterfactual.horizons.map((point) => point.horizonSeconds)).toEqual([30]);
    expect(evaluated.counterfactual.horizons[0]).toMatchObject({
      observedAt: timestamp(33),
      observationLagSeconds: 3
    });
  });
});
