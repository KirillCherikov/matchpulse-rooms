# Replay

Replay is the complete, credential-free MVP path. The bundled input is always labeled `Synthetic demo data — not a real match`.

## Controls

- Start
- Pause
- Resume
- Reset
- Next event
- 1x, 2x, 5x, and 10x playback cadence

`Next event` processes exactly one input and leaves replay paused unless that input completes the run. Playback speed changes scheduler cadence only; source timestamps, received timestamps, order, and calculations remain unchanged.

## Deterministic clock and ordering

Replay messages must be ordered by nondecreasing `receivedTimestamp`. The simulated clock advances to each processed message's received time. Source timestamps can expose delayed or out-of-order source data, but a future received message is never visible to the decision pipeline.

The same ordered input and configuration produce the same domain movements, rules, score components, positions, settlement, and analytics. Run-scoped IDs and process-level audit sequence numbers change between runs by design. Control events issued when no simulated time exists can use wall-clock time, so the complete process audit JSON is not intended to be byte-identical across separate interactive sessions.

## Reset and restart

Reset performs an atomic dynamic reset:

- provider cursor, status, speed, and simulated time;
- score and odds quality state, duplicate memory, and active stale state;
- correlator history and pending event-divergence checks;
- rolling signal state, sequence, signals, and explanations;
- paper positions, virtual bankroll, exposure, settlement state, and drawdown;
- counterfactual observations and current fixture state.

It then begins a new `replay-run-NNNN` namespace. Starting after a finished run performs the same clean-run initialization automatically.

The audit store is append-only for the life of the process: previous events remain available and are separated by `runId`. This preserves operational history without leaking old signals or positions into the new run.

## Synthetic scenario

The scenario contains kickoff, baseline odds, a confirmed home goal, a rapid directionally consistent market reaction, a duplicate update, stale intervals, a sequence gap, an out-of-order update, a delayed score event, recovery, counterfactual observations, and confirmed full-time settlement.

## Limitations

- The fixture is synthetic, not recorded TxLINE data.
- State is in memory and disappears on process restart.
- The scheduler emits one event per cadence interval rather than scaling original inter-arrival durations.
- Previous event/rewind is not exposed; Reset plus deterministic advance is the reproducible fallback.
- Browser sessions receive isolated replay agents through an opaque HttpOnly cookie. The bounded registry is memory-only and expires inactive sessions after 30 minutes.
