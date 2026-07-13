# Sub-five-minute demo script

Target an encoded runtime of **4:40** (acceptable rehearsal range **4:30–4:45**) so upload/transitions cannot push the entry over the hard five-minute limit. The final exported file must be strictly shorter than `5:00`; verify its actual duration before submission.

## 0:00–0:18 — Product and safety boundary

“TxLINE Sentinel turns verifiable sports data into explainable market-operations evidence and a reproducible simulation-only decision trail.”

Show **SIMULATION ONLY — NO REAL MONEY**. State that the product has no bookmaker execution, wallet custody, deposit, withdrawal, or profit promise.

## 0:18–1:18 — LIVE DEVNET TXLINE

Open <https://txline-sentinel.onrender.com> and select **LIVE DEVNET TXLINE**.

Show:

- network **SOLANA DEVNET**;
- authenticated TxLINE API state;
- odds and scores stream status, heartbeat/event time, and reconnect attempt;
- latest real fixture and provider timestamps;
- `Verified`, `Verification failed`, or `Verification unavailable` without overstating the evidence.

Narration:

“This is the official devnet origin with a free on-chain subscription. Service level 1 was read from the pricing matrix at zero TxL, and `subscribe(1,4)` finalized from our disposable devnet wallet. The authenticated smoke returned seven real fixtures, including fixture 18143850, Vietnam–Myanmar. Odds SSE delivered a real event; scores SSE opened and delivered a heartbeat. A heartbeat-only stream is connected and awaiting covered data, not a fabricated live match.”

Briefly show the public [devnet transaction](https://explorer.solana.com/tx/2oxcjpbnGZFaw2R2Sk4ptc7dJ5Y6tPNRfJXzc6sZFEY66h1FPsvGkGyqYQigdPmDBgYM2RJCEtdjzaHxHNrXabdj?cluster=devnet) and `/api/live/status`.

“The proof flow fetched official fixture proof data, derived the devnet root PDA, and `validateFixture` returned true in read-only simulation. The UI never marks a record Verified merely because HTTP succeeded.”

Do not open developer tools containing request headers, local credential files, wallet JSON, raw third-party datasets, or Render secret values.

## 1:18–1:35 — Architecture

Show the README diagram.

“The authenticated TxLINE sidecar and deterministic replay are separated. Official payloads pass strict Zod schemas and adapters. Live is read-only decision support; replay guarantees the same signal and settlement walkthrough even between matches.”

Mention the deliberate odds boundary: TxLINE integer `Prices` are retained exactly; Sentinel does not invent a decimal scale or use them for a paper position without an official conversion contract.

## 1:35–2:40 — SYNTHETIC REPLAY signal

Switch to **SYNTHETIC REPLAY**. Confirm `Synthetic demo data — not a real match`, then click **Reset** and **Next event** five times.

Show:

- confirmed home goal;
- normalized Home win movement and velocity;
- `post_event_reaction` relationship;
- Rule-based confidence score and signed component reasons;
- risk-capped virtual position.

Narration:

“The correlator requires the event source to precede the odds source and the confirmation to be received by decision time. A late confirmation can be context, but cannot open this strategy. Book percentage is the sum of implied probabilities; classical overround is that sum minus one.”

## 2:40–3:06 — Data quality and recovery

Advance through duplicate, gap, stale, out-of-order, delayed, divergence, and recovery inputs. Show that operational alerts remain separate from signals and current health returns to healthy while history remains auditable.

## 3:06–3:32 — Counterfactual explanation

Open signal detail. Show causal source/received timing and 30/60/300-second retained-movement ratios.

“A small retracement is not called a reversal. Persisted means at least 60% remains; reversal requires the initial move to be fully lost.”

## 3:32–4:00 — Paper settlement

Choose 10x and click **Start**. Show confirmed full-time settlement, virtual P&L, exposure returning to zero, signal precision, and maximum settled-equity drawdown.

“These are virtual units for evaluation. This is not evidence or a promise of profitability.”

## 4:00–4:40 — Audit and closing

Show the audit timeline and `/docs`.

“Inputs, sanitized references, normalized records, alerts, score components, decisions, paper execution, counterfactual points, and settlement share run-scoped correlation IDs. Live proves the official TxLINE integration; replay makes the decision logic deterministic and judgeable on demand.”

Close on three points:

1. real authenticated TxLINE devnet HTTP/SSE;
2. actual on-chain proof verification rather than a decorative badge;
3. explainable, auditable simulation without a real-money execution path.

## Exact click sequence

1. LIVE DEVNET TXLINE.
2. Inspect API, fixture, streams, and proof status.
3. Open `/api/live/status` or the devnet transaction in a second tab.
4. SYNTHETIC REPLAY.
5. Reset.
6. Next event ×5.
7. Inspect signal and position.
8. Advance until data-quality alerts are visible.
9. Open signal detail and return.
10. Select 10x and Start.
11. Inspect settlement, analytics, audit, and `/docs`.

## Backup flow

If Render is temporarily unavailable, run the Docker flow in [DEPLOYMENT.md](DEPLOYMENT.md). If TxLINE has no active covered match, show the authenticated fixture snapshot and stream heartbeat, then use deterministic replay for the guaranteed event/signal/settlement sequence. Never relabel synthetic replay as a real match.
