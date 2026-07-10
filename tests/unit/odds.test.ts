import { describe, expect, it } from "vitest";
import { providerMessageSchema } from "../../src/domain/schemas.js";
import {
  calculateBookPercentage,
  calculateMovement,
  calculateOverround,
  impliedProbability,
  normalizeOddsUpdate,
  normalizeImpliedProbabilities,
  rollingBaseline
} from "../../src/engine/odds.js";
import { oddsUpdate } from "../helpers.js";

describe("odds normalization", () => {
  it("converts decimal odds to implied probability", () => {
    expect(impliedProbability(2)).toBe(0.5);
    expect(() => impliedProbability(1)).toThrow("greater than 1");
    expect(() => impliedProbability(Number.MAX_VALUE)).toThrow("at most 1000000");
  });

  it("distinguishes book percentage from classic overround", () => {
    const prices = [2, 10 / 3, 2.5];
    expect(calculateBookPercentage(prices)).toBeCloseTo(1.2, 12);
    expect(calculateOverround(prices)).toBeCloseTo(0.2, 12);

    const normalized = normalizeImpliedProbabilities([0.6, 0.3, 0.3]);
    expect(normalized.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(normalized[0]).toBeCloseTo(0.5);
  });

  it("normalizes a full market without calling implied probability a true outcome probability", () => {
    const snapshot = normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 2));
    expect(snapshot.bookPercentage).toBeGreaterThan(1);
    expect(snapshot.overround).toBeCloseTo(snapshot.bookPercentage - 1, 12);
    expect(snapshot.overround).toBeLessThan(snapshot.bookPercentage);
    expect(
      snapshot.selections.reduce((sum, selection) => sum + selection.normalizedProbability, 0)
    ).toBeCloseTo(1);
    expect(snapshot.selections[0]?.impliedProbability).toBeCloseTo(0.5);
  });

  it("calculates movement, velocity, acceleration, and rolling baseline", () => {
    const previous = normalizeOddsUpdate(oddsUpdate("one", 1, 0, 3.2));
    const current = normalizeOddsUpdate(oddsUpdate("two", 2, 10, 1.8));
    const movement = calculateMovement(previous, current, "home", [0.01, -0.02, 0.015], 0.001);
    expect(movement.probabilityDelta).toBeGreaterThan(0);
    expect(movement.percentagePointMovement).toBeGreaterThan(0);
    expect(movement.velocityPerSecond).toBeGreaterThan(0);
    expect(movement.rollingBaseline.sampleSize).toBe(3);
    expect(rollingBaseline([0.01, -0.02]).volatility).toBeGreaterThan(0);
  });

  it("refuses to calculate velocity when neither source nor receive time advances", () => {
    const previous = normalizeOddsUpdate(oddsUpdate("one", 1, 10, 3.2));
    const current = normalizeOddsUpdate(oddsUpdate("two", 2, 10, 1.8));
    expect(() => calculateMovement(previous, current, "home", [])).toThrow(
      "Odds timestamps must advance"
    );
  });

  it("rejects malformed provider payloads through Zod", () => {
    const invalid = oddsUpdate("bad", 1, 0);
    invalid.selections[1] = { selection: "home", decimalOdds: 3.4 };
    expect(providerMessageSchema.safeParse(invalid).success).toBe(false);
  });
});
