# Signal engine

## Candidate detection

Typed configuration controls:

- absolute normalized-probability movement;
- absolute movement velocity;
- abnormality against the rolling absolute-movement baseline;
- qualified momentum continuation;
- market reversal context;
- confirmed-event association inside the configured source-time window;
- current data-quality penalties and critical-feed inhibition.

The strongest material selection is emitted at most once per accepted odds snapshot. A movement with no causal confirmed event is labeled `unexplained_market_movement`; no sporting cause is invented.

## Causal event correlation

Correlation has two independent gates:

1. The event source time must precede or equal the odds source time and be no more than the configured window behind it.
2. The event must have been received by the agent no later than the odds update's received time.

This prevents look-ahead bias in replay and backtests.

Relationships are explicit:

- `post_event_reaction`: the confirmed event was already received by the odds source time;
- `late_event_confirmation`: the event source preceded the odds movement, but confirmation arrived after the odds source time and before the decision time.

Late confirmation may be attached as context, but it is not eligible for the simulated confirmation position. Directional confirmation is deliberately conservative: a positive home/away move is supported by a goal for that selection or a red card for the opposing team. Other temporal associations are retained without being called directionally confirmed.

## Paper eligibility

A signal is eligible for opening only when all of the following hold:

- relationship is `post_event_reaction`;
- event direction supports the selected positive movement;
- the fixture is live;
- the Rule-based confidence score meets the configured trading threshold;
- no critical or stale feed condition is active.

The paper simulator can still decline an eligible signal when its exposure cap leaves no stake capacity. Negative selection movements and draw movements are not opened by the current long-confirmation strategy.

## Rule-based confidence score

The score is the clamped sum of transparent components. Default configuration:

| Component                                       | Contribution |
| ----------------------------------------------- | -----------: |
| Base                                            |      `+0.32` |
| Absolute probability shift                      |      `+0.16` |
| Rapid probability shift                         |      `+0.14` |
| Abnormal relative to baseline                   |      `+0.08` |
| Momentum continuation                           |      `+0.06` |
| Confirmed, directionally consistent match event |      `+0.22` |
| Late event confirmation                         |      `+0.04` |
| Unexplained movement                            |      `-0.03` |
| Warning data quality                            |      `-0.12` |
| Critical data quality                           |      `-0.35` |

The final score is clamped to `[0.05, 0.98]`. The default paper-eligibility threshold is `0.72`; the default outbound Telegram notification threshold is `0.80`. Thresholds, weights, and strategy configuration version have one typed configuration source.

Every signal stores its component list, so the score can be reproduced from the configuration version and triggered rules.

### Interpretation limits

The Rule-based confidence score:

- is not trained on an outcome dataset;
- is not statistically calibrated;
- is not a probability of winning;
- does not guarantee movement persistence or virtual profit;
- should not be compared across configuration versions without accounting for changed weights;
- can be high while later counterfactual or settlement results are unfavorable.

## Counterfactual evaluation

For each 30, 60, and 300-second horizon, the evaluator accepts the first snapshot whose source-time elapsed value and received-time availability elapsed value both fall between the target and the configured maximum-lag boundary. It then computes:

```text
sourceElapsed = snapshot.sourceTimestamp - signal.sourceTimestamp
availabilityElapsed = snapshot.receivedTimestamp - signal.sourceTimestamp
observationLag = availabilityElapsed - horizon
retainedMovement = observedProbability - probabilityBeforeSignal
retainedMovementRatio = retainedMovement / initialSignalMovement
```

Default classification:

- `persisted` when retained ratio is at least `0.60`;
- `reversed` when retained ratio is at most `0.00`, meaning the initial move has been fully lost or crossed;
- `inconclusive` between those thresholds.

A small retracement therefore remains `persisted` when at least 60% of the initial movement remains. Each point records the snapshot's received timestamp as `observedAt`, normalized probability, post-signal change, retained ratio, and received-availability lag after the horizon. A horizon is populated only when both source progression and received availability are no more than 30 seconds after its target; a materially delayed snapshot does not backfill a missed short horizon.

The signal snapshot records the immediate entry. The first eligible 30-second horizon snapshot records the confirmation entry; `confirmationDelaySeconds` is its received timestamp minus the signal's received timestamp. If that observation is unavailable or too late, confirmation entry remains unavailable. At terminal settlement, unit returns for immediate and confirmation entries are compared as `immediate`, `confirmation`, `equal`, or `unavailable`. The 60-second point supplies the aggregate movement assessment and signal-persistence metric.

The evaluator does not interpolate between snapshots. `observationLagSeconds` is the received-availability elapsed value minus the target horizon and is bounded by the configured maximum lag.

## Explainability

Explanations are deterministic templates. They describe the movement, causal relationship when one exists, current data-quality context, paper decision, and machine-readable reasons. No paid LLM is required.
