import type { CounterfactualPoint, NormalizedOddsSnapshot, Signal } from "../domain/models.js";
import { selectionFor } from "./odds.js";

const HORIZONS_SECONDS = [30, 60, 300];

export function updateCounterfactuals(
  signals: Signal[],
  snapshot: NormalizedOddsSnapshot,
  thresholds: {
    persistenceRatio: number;
    reversalRatio: number;
    maxObservationLagSeconds: number;
  }
): Signal[] {
  return signals.map((signal) => {
    if (signal.fixtureId !== snapshot.fixtureId || signal.market !== snapshot.market) {
      return signal;
    }
    const elapsedSeconds =
      (new Date(snapshot.sourceTimestamp).getTime() - new Date(signal.sourceTimestamp).getTime()) /
      1_000;
    const decisionElapsedSeconds =
      (new Date(snapshot.receivedTimestamp).getTime() -
        new Date(signal.receivedTimestamp).getTime()) /
      1_000;
    const observedElapsedSeconds =
      (new Date(snapshot.receivedTimestamp).getTime() -
        new Date(signal.sourceTimestamp).getTime()) /
      1_000;
    if (elapsedSeconds <= 0 || decisionElapsedSeconds <= 0 || observedElapsedSeconds <= 0) {
      return signal;
    }
    const current = selectionFor(snapshot, signal.selection);
    const probabilityChangeAfterSignal =
      current.normalizedProbability - signal.normalizedProbabilityAfter;
    const retainedMovement = current.normalizedProbability - signal.normalizedProbabilityBefore;
    const retainedMovementRatio =
      signal.movement.probabilityDelta === 0
        ? 0
        : retainedMovement / signal.movement.probabilityDelta;
    const classification: CounterfactualPoint["classification"] =
      retainedMovementRatio >= thresholds.persistenceRatio
        ? "persisted"
        : retainedMovementRatio <= thresholds.reversalRatio
          ? "reversed"
          : "inconclusive";
    const existing = signal.counterfactual.horizons;
    const newPoints = HORIZONS_SECONDS.filter(
      (horizonSeconds) =>
        elapsedSeconds >= horizonSeconds &&
        elapsedSeconds - horizonSeconds <= thresholds.maxObservationLagSeconds &&
        observedElapsedSeconds >= horizonSeconds &&
        observedElapsedSeconds - horizonSeconds <= thresholds.maxObservationLagSeconds &&
        !existing.some((point) => point.horizonSeconds === horizonSeconds)
    ).map((horizonSeconds) => ({
      horizonSeconds,
      observedAt: snapshot.receivedTimestamp,
      normalizedProbability: current.normalizedProbability,
      probabilityChangeAfterSignal,
      retainedMovementRatio,
      observationLagSeconds: observedElapsedSeconds - horizonSeconds,
      classification
    }));
    if (newPoints.length === 0) {
      return signal;
    }
    const thirtySecondPoint = newPoints.find((point) => point.horizonSeconds === 30);
    const sixtySecondPoint = newPoints.find((point) => point.horizonSeconds === 60);
    return {
      ...signal,
      counterfactual: {
        ...signal.counterfactual,
        horizons: [...existing, ...newPoints],
        ...(thirtySecondPoint && signal.counterfactual.confirmationEntryOdds === undefined
          ? {
              confirmationEntryOdds: current.decimalOdds,
              confirmationDelaySeconds: decisionElapsedSeconds
            }
          : {}),
        ...(sixtySecondPoint ? { movementAssessment: sixtySecondPoint.classification } : {})
      }
    };
  });
}
