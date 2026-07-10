# Five-minute demo script

## 0:00–0:25 — Problem

“A price movement is not enough. Market operations teams need to know what changed, whether an event available at decision time explains it, whether the feed is trustworthy, and whether the decision can be reproduced.”

Show `SIMULATION ONLY — NO REAL MONEY` and the synthetic-data label.

## 0:25–0:55 — Architecture

Show the README diagram: provider → Zod validation → normalized domain models → data quality and causal correlation → explainable signal → paper simulation and counterfactuals → audit/API/dashboard.

Narration: “Book percentage is the sum of implied probabilities; classical overround is that sum minus one. Normalized values are market comparisons, not claimed true probabilities.”

## 0:55–2:20 — Causal event-confirmed movement

Open the dashboard. Click **Reset**, then **Next event** five times.

Show:

- confirmed home goal;
- normalized Home win movement and velocity;
- `post_event_reaction` relationship;
- Rule-based confidence score and component reasons;
- simulated confirmation position.

Narration: “The correlator requires the event source to precede the odds source and the confirmation to be received by decision time. A late confirmation can be context, but cannot open this strategy.”

## 2:20–3:00 — Data quality

Advance through duplicate, gap, stale, out-of-order, delayed, divergence, and recovery inputs. Show that operational alerts remain separate from signals and current health becomes healthy again after recovery.

## 3:00–3:40 — Counterfactual explanation

Open signal detail. Show the triggered rules, causal event relationship, source/received latency, and 30/60/300-second retained-movement ratios.

Narration: “A small retracement is not called a reversal. Persisted means at least 60% remains; reversal requires the initial move to be fully lost.”

## 3:40–4:15 — Settlement and analytics

Choose 10x and click **Start**. Show confirmed full-time paper settlement, virtual P&L, open exposure returning to zero, signal precision, and maximum settled-equity drawdown.

State clearly that these are virtual units and not evidence of profitability.

## 4:15–4:40 — Auditability and restart

Show audit timeline and `/docs`. Explain that inputs, normalized records, alerts, score components, decision, paper execution, counterfactual points, and settlement share correlation IDs and a run ID. Starting another finished replay clears dynamic state while retaining prior append-only audit history.

## 4:40–5:00 — TxLINE and honest status

“Replay makes the complete decision system judgeable now. The provider boundary is ready for official TxLINE schemas, but the current build calls no TxLINE data endpoint and performs no transaction. Public deployment is pending platform authorization.”

Mention [API feedback](API_FEEDBACK.md).

## Exact click sequence

1. Reset.
2. Next event ×5.
3. Inspect signal and position.
4. Next event until data-quality alerts are visible.
5. Open signal detail and return.
6. Select 10x.
7. Start.
8. Inspect settlement, analytics, and audit.
9. Open `/docs` in a second tab.

## Backup terminal flow

```bash
npm run build
npm start
npm run cli -- replay run
```

If a public deployment is unavailable, run the Docker flow from `DEPLOYMENT.md` and record localhost in the demo. If the browser flow fails, show CLI replay JSON and OpenAPI using the same deterministic fixture.
