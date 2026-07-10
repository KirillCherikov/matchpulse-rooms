import type { CounterfactualPoint, NormalizedOddsSnapshot, Signal } from "../domain/models.js";
import { selectionFor } from "./odds.js";

const HORIZONS_SECONDS = [30, 60, 300];

export function updateCounterfactuals(
  signals: Signal[],
  snapshot: NormalizedOddsSnapshot
): Signal[] {
  return signals.map((signal) => {
    if (signal.fixtureId !== snapshot.fixtureId || signal.market !== snapshot.market) {
      return signal;
    }
    const elapsedSeconds =
      (new Date(snapshot.sourceTimestamp).getTime() - new Date(signal.sourceTimestamp).getTime()) /
      1_000;
    if (elapsedSeconds <= 0) {
      return signal;
    }
    const current = selectionFor(snapshot, signal.selection);
    const probabilityDelta = current.normalizedProbability - signal.normalizedProbabilityAfter;
    const signalDirection = Math.sign(signal.movement.probabilityDelta);
    const classification: CounterfactualPoint["classification"] =
      Math.sign(probabilityDelta) === signalDirection && Math.abs(probabilityDelta) > 0.005
        ? "persisted"
        : Math.sign(probabilityDelta) === -signalDirection
          ? "reversed"
          : "inconclusive";
    const existing = signal.counterfactual.horizons;
    const newPoints = HORIZONS_SECONDS.filter(
      (horizonSeconds) =>
        elapsedSeconds >= horizonSeconds &&
        !existing.some((point) => point.horizonSeconds === horizonSeconds)
    ).map((horizonSeconds) => ({
      horizonSeconds,
      observedAt: snapshot.sourceTimestamp,
      normalizedProbability: current.normalizedProbability,
      probabilityDelta,
      classification
    }));
    if (newPoints.length === 0 && signal.counterfactual.confirmationEntryOdds !== undefined) {
      return signal;
    }
    return {
      ...signal,
      counterfactual: {
        ...signal.counterfactual,
        ...(signal.counterfactual.confirmationEntryOdds === undefined
          ? { confirmationEntryOdds: current.decimalOdds }
          : {}),
        horizons: [...existing, ...newPoints],
        ...(newPoints.some((point) => point.horizonSeconds === 60)
          ? {
              movementPersisted:
                newPoints.find((point) => point.horizonSeconds === 60)?.classification ===
                "persisted"
            }
          : {})
      }
    };
  });
}
