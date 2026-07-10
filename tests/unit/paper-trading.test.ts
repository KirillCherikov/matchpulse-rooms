import { describe, expect, it } from "vitest";
import { updateCounterfactuals } from "../../src/engine/counterfactual.js";
import { normalizeOddsUpdate } from "../../src/engine/odds.js";
import { PaperTradingSimulator } from "../../src/engine/paper-trading.js";
import { oddsUpdate, paperEligibleSignal } from "../helpers.js";

describe("paper trading simulation", () => {
  it("opens a capped paper position and settles virtual P&L", () => {
    const simulator = new PaperTradingSimulator({
      initialVirtualBankroll: 100,
      stakeFraction: 0.2,
      maxExposureFraction: 0.1
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
      maxExposureFraction: 0.1
    });
    simulator.openForSignal(paperEligibleSignal({ fixtureId: "loss-fixture", id: "loss" }));
    simulator.settle("loss-fixture", "away", "2026-01-01T12:02:00.000Z");
    const analytics = simulator.analytics([]);
    expect(analytics.virtualPnl).toBe(-10);
    expect(analytics.maximumDrawdown).toBe(10);
  });

  it("evaluates whether an observed move persisted at counterfactual horizons", () => {
    const signal = paperEligibleSignal({
      sourceTimestamp: "2026-01-01T12:00:00.000Z",
      normalizedProbabilityAfter: 0.4
    });
    const snapshot = normalizeOddsUpdate(oddsUpdate("later", 2, 61, 1.6));
    const evaluated = updateCounterfactuals([signal], snapshot)[0];
    expect(evaluated?.counterfactual.horizons.map((point) => point.horizonSeconds)).toEqual([
      30, 60
    ]);
  });
});
