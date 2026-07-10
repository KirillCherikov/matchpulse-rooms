import type {
  MovementMetrics,
  NormalizedOddsSelection,
  NormalizedOddsSnapshot,
  OddsUpdate,
  RollingBaseline,
  SelectionKey
} from "../domain/models.js";

export function impliedProbability(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    throw new Error("Decimal odds must be a finite number greater than 1");
  }
  return 1 / decimalOdds;
}

export function calculateOverround(decimalOdds: number[]): number {
  if (decimalOdds.length === 0) {
    throw new Error("At least one price is required to calculate overround");
  }
  return decimalOdds.reduce((sum, price) => sum + impliedProbability(price), 0);
}

export function removeOverround(impliedProbabilities: number[]): number[] {
  const total = impliedProbabilities.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Implied probabilities must have a positive total");
  }
  return impliedProbabilities.map((value) => value / total);
}

export function normalizeOddsUpdate(update: OddsUpdate): NormalizedOddsSnapshot {
  const implied = update.selections.map((selection) => impliedProbability(selection.decimalOdds));
  const overround = implied.reduce((sum, probability) => sum + probability, 0);
  const normalized = removeOverround(implied);
  const selections: NormalizedOddsSelection[] = update.selections.map((selection, index) => ({
    ...selection,
    impliedProbability: implied[index] ?? 0,
    normalizedProbability: normalized[index] ?? 0
  }));
  return { ...update, selections, overround };
}

export function selectionFor(
  snapshot: NormalizedOddsSnapshot,
  selection: SelectionKey
): NormalizedOddsSelection {
  const found = snapshot.selections.find((candidate) => candidate.selection === selection);
  if (!found) {
    throw new Error(`Selection ${selection} was not present in odds snapshot ${snapshot.id}`);
  }
  return found;
}

export function rollingBaseline(movements: number[]): RollingBaseline {
  if (movements.length === 0) {
    return { sampleSize: 0, meanAbsoluteMovement: 0, standardDeviation: 0, volatility: 0 };
  }
  const absolute = movements.map(Math.abs);
  const meanAbsoluteMovement = absolute.reduce((sum, value) => sum + value, 0) / absolute.length;
  const variance =
    absolute.reduce((sum, value) => sum + (value - meanAbsoluteMovement) ** 2, 0) / absolute.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    sampleSize: movements.length,
    meanAbsoluteMovement,
    standardDeviation,
    volatility: standardDeviation
  };
}

export function calculateMovement(
  previous: NormalizedOddsSnapshot,
  current: NormalizedOddsSnapshot,
  selection: SelectionKey,
  movements: number[],
  previousVelocity = 0
): MovementMetrics {
  const before = selectionFor(previous, selection);
  const after = selectionFor(current, selection);
  const probabilityDelta = after.normalizedProbability - before.normalizedProbability;
  const elapsedMs = Math.max(
    1,
    new Date(current.sourceTimestamp).getTime() - new Date(previous.sourceTimestamp).getTime()
  );
  const elapsedSeconds = elapsedMs / 1_000;
  const velocityPerSecond = probabilityDelta / elapsedSeconds;
  return {
    probabilityDelta,
    percentagePointMovement: probabilityDelta * 100,
    velocityPerSecond,
    accelerationPerSecondSquared: (velocityPerSecond - previousVelocity) / elapsedSeconds,
    rollingBaseline: rollingBaseline(movements)
  };
}
