# Judge guide

TxLINE Sentinel's complete judge path is deterministic replay and requires no live credential, wallet, network transaction, bookmaker account, or real money.

> **SIMULATION ONLY — NO REAL MONEY**

## Dashboard fast path

1. Open <https://txline-sentinel.onrender.com> (or `http://localhost:3000` for the local backup).
2. Confirm `Synthetic demo data — not a real match` and the simulation disclaimer.
3. Click **Reset**, then **Next event** five times.
4. Inspect the Home win normalized-probability movement and the latest confirmed goal.
5. Read the **Rule-based confidence score** and its deterministic explanation. The score is a heuristic, not a probability.
6. Verify the virtual position and its strict exposure-capped stake.
7. Continue with **Next event** to expose duplicate, stale, sequence-gap, out-of-order, delayed, divergence, and recovery behavior.
8. Confirm that current feed health recovers while historical alerts remain visible.
9. Select 10x and click **Start** to finish the run.
10. Verify confirmed full-time settlement, virtual P&L, signal precision, and settled-equity drawdown.
11. Open signal detail and inspect causal relationship plus 30/60/300-second retained-movement classifications.
12. Inspect the audit timeline and its run-scoped correlation IDs.

Starting again after finished state begins a clean dynamic run. Prior audit events remain append-only under their earlier `runId`.

## API path

Open <https://txline-sentinel.onrender.com/docs> for the interactive OpenAPI contract or `/docs/json` for the machine-readable form.

Suggested sequence:

```bash
BASE_URL="${BASE_URL:-https://txline-sentinel.onrender.com}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/reset"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/advance"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/agent/status"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/signals"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/alerts"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/positions"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/analytics"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/audit?limit=100"
```

Keep the same cookie jar for the entire sequence; otherwise each request creates a different isolated replay session. Set `BASE_URL=http://localhost:3000` for the local backup.

## CLI backup

```bash
npm run cli -- replay run
npm run cli -- signals list
npm run cli -- alerts list
```

These are independent one-shot local runs. Use the dashboard or REST API for interactive continuing controls.

## Interpretation checklist

- `bookPercentage` is the sum of implied probabilities.
- `overround` is classical overround: `bookPercentage - 1`.
- normalized probability is a margin-adjusted market value, not a true probability.
- late confirmation does not use future data and cannot open the current paper strategy.
- `persisted` means at least 60% of the original movement remains by default.
- signal precision measures 60-second movement persistence, not betting accuracy or profit potential.
