# Data model

## Transport-independent inputs

`OddsUpdate` contains a fixture ID, market, independent odds-feed sequence, source and received timestamps, three decimal selections, and a sanitized raw reference. `MatchEvent` carries the score-feed sequence, both timestamps, event type, minute, confirmation state, optional team, optional score, and sanitized reference.

The strategy does not consume raw HTTP response types. A live transport must validate an official payload and map it to these models before ingestion.

## Time semantics

- `sourceTimestamp` is the provider's time for the sporting or market observation.
- `receivedTimestamp` is when that update became available to the agent.
- Decisions may use only records whose `receivedTimestamp` is no later than the decision update's `receivedTimestamp`.
- Score and odds sequences are tracked separately.

Invalid timestamps, including a received time earlier than its source time, are rejected by the data-quality layer.

## Odds mathematics

For decimal odds `o_i`:

```text
impliedProbability_i = 1 / o_i
bookPercentage       = sum(impliedProbability_i)
overround            = bookPercentage - 1
normalizedProbability_i = impliedProbability_i / bookPercentage
```

`bookPercentage` and `overround` are deliberately separate fields. Classical overround is the excess above one, so a fair book has `overround = 0`; an underround book can have a negative value. Normalized probabilities sum to one, subject to floating-point tolerance.

Neither implied probability nor normalized probability is represented as a true or statistically estimated outcome probability. Normalization is a proportional margin-removal method for market comparison.

Provider decimal odds must be greater than one and no greater than `1,000,000`. This deliberately generous domain guard is far above realistic football prices while preventing finite-number overflow from corrupting simulation or JSON/audit state.

## Movement records

Movement is calculated from consecutive normalized snapshots for the same fixture, market, and selection:

- `probabilityDelta` is current minus previous normalized probability;
- `percentagePointMovement` is `probabilityDelta * 100`;
- velocity divides the delta by advancing source-time elapsed seconds, falling back to advancing received time;
- acceleration compares current and previous velocity over the same elapsed interval;
- the rolling baseline stores sample count, mean absolute movement, standard deviation, and volatility.

Non-advancing time is rejected rather than converted into an artificial one-millisecond interval.

## Event association

`CorrelatedEvent` records:

- the confirmed event;
- `post_event_reaction` or `late_event_confirmation`;
- `sourceLagMs`, from event source time to odds source time;
- `confirmationLeadMs`, from event received time to decision received time.

The model does not use an absolute timestamp distance. A future-source event or an event not received by decision time cannot be attached to a signal.

## Decision records

Each signal stores the before/after odds and probabilities, movement metrics, source and received timestamps, causal event relationship, latency, triggered rules, componentized Rule-based confidence score, explanation, strategy configuration version, paper decision, counterfactual horizons, and later settlement outcome.

The Rule-based confidence score is a deterministic engineering heuristic. It is not a calibrated probability.

## Replay and audit identity

Signals, alerts, and paper positions include a replay-run namespace. Audit events include `runId`, monotonically increasing process-level sequence, correlation ID, event type, timestamp, and structured data. Reset clears dynamic decision state but intentionally does not rewrite prior audit history.
