import { describe, expect, it } from "vitest";
import { providerMessageSchema } from "../../src/domain/schemas.js";
import {
  calculateMovement,
  calculateOverround,
  impliedProbability,
  normalizeOddsUpdate,
  removeOverround,
  rollingBaseline
} from "../../src/engine/odds.js";
import { oddsUpdate } from "../helpers.js";

describe("odds normalization", () => {
  it("converts decimal odds to implied probability", () => {
    expect(impliedProbability(2)).toBe(0.5);
    expect(() => impliedProbability(1)).toThrow("greater than 1");
  });

  it("calculates and removes market overround", () => {
    expect(calculateOverround([2, 4, 4])).toBe(1);
    const normalized = removeOverround([0.6, 0.3, 0.3]);
    expect(normalized.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(normalized[0]).toBeCloseTo(0.5);
  });

  it("normalizes a full market without calling implied probability a true outcome probability", () => {
    const snapshot = normalizeOddsUpdate(oddsUpdate("opening", 1, 0, 2));
    expect(snapshot.overround).toBeGreaterThan(1);
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

  it("rejects malformed provider payloads through Zod", () => {
    const invalid = oddsUpdate("bad", 1, 0);
    invalid.selections[1] = { selection: "home", decimalOdds: 3.4 };
    expect(providerMessageSchema.safeParse(invalid).success).toBe(false);
  });
});
