# Data quality sentinel

Operational alerts are independent of market signals. A feed problem can inhibit paper eligibility without being represented as a trading opportunity.

## Per-feed state

Odds and score feeds keep separate state for each fixture:

- last accepted sequence;
- last accepted source and received timestamps;
- active stale flag;
- bounded insertion-ordered set of seen IDs.

Issue-suppression memory is bounded as well. Reset clears all quality state, so one replay run cannot contaminate the next.

## Alerts

| Alert                   | Detection and action                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale_feed`            | Silence exceeds the feed-specific received-time threshold; marks that feed stale and creates one critical alert.                                     |
| `duplicate_update`      | Repeated ID or repeated current sequence; update is ignored.                                                                                         |
| `out_of_order_update`   | Regressing sequence or source/received timestamp; update is ignored.                                                                                 |
| `sequence_gap`          | Accepted sequence skips one or more values; processing continues with a warning.                                                                     |
| `delayed_update`        | Nonnegative receive-minus-source latency exceeds the threshold.                                                                                      |
| `feed_recovery`         | The first valid accepted update after a stale interval clears active stale state.                                                                    |
| `odds_score_divergence` | Material odds movement lacks a causal, directionally consistent confirmed event, or an eligible confirmed event receives no market reaction in time. |
| `invalid_timestamp`     | Timestamp is invalid or received time precedes source time; update is ignored.                                                                       |
| `malformed_payload`     | Reserved for recording an adapter-level Zod validation failure.                                                                                      |

Duplicate and out-of-order rejected records do not advance feed state. Score and odds sequence values are never compared to one another.

## Current health versus history

`AgentStatus.feedHealth` reports current odds and score states as `unknown`, `healthy`, or `stale`, with an aggregate `unknown`, `healthy`, or `degraded` status. Historical critical alerts remain visible after recovery, but they do not keep current health degraded once a valid recovery update is accepted.

## Signal interaction

Warning and critical alerts reduce the Rule-based confidence score through explicit components. An active stale feed or critical alert prevents opening a simulated position. The signal and alert remain separate audit records.

## Synthetic coverage

The bundled replay intentionally demonstrates duplicate ID, sequence gap, out-of-order update, stale feed, delayed update, recovery, and odds/score divergence. Invalid timestamp and duplicate-sequence paths are exercised in unit tests rather than inserted into the main judge scenario.
