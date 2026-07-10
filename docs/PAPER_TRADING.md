# Paper trading

> **SIMULATION ONLY — NO REAL MONEY**

All positions, stakes, bankroll values, exposure, returns, and P&L are virtual accounting records. There is no bookmaker or wallet execution.

## Opening a position

The default configuration starts with `1,000` virtual units, requests a stake equal to 2% of current settled bankroll, and caps aggregate open exposure at 10% of current settled bankroll.

For each eligible signal:

```text
requestedStake = bankroll * stakeFraction
exposureCap     = bankroll * maxExposureFraction
stake = min(requestedStake, exposureCap - openExposure, bankroll - openExposure)
```

The stake is rounded to two decimals. A non-positive result declines the paper action. Processed signal IDs prevent duplicate openings, and concurrent positions share the same exposure cap. Stake is not deducted from settled bankroll while a position is open; it is reported separately as open exposure.

## Settlement

Only accepted confirmed events can settle positions:

- confirmed full time derives `home`, `draw`, or `away` from the final score;
- a draw selection wins when the final result is a draw;
- confirmed cancellation or postponement voids open positions;
- an already settled position is ignored on repeated settlement.

Virtual P&L is:

```text
won  = stake * (entryOdds - 1)
lost = -stake
void = 0
```

All positions for the fixture are settled as one batch and aggregate net P&L is then applied once to settled bankroll. Void positions do not affect bankroll and are excluded from win rate and average return.

## Drawdown

Peak equity is the highest observed settled bankroll. After a settlement batch:

```text
currentDrawdown = peakSettledBankroll - currentSettledBankroll
drawdownPercent = currentDrawdown / peakSettledBankroll
```

Maximum drawdown is the largest settled-equity decline observed since reset. Open positions are not marked to market, so unrealized movement and intra-position drawdown are intentionally outside the MVP metric.

## Analytics

- `virtualBankroll`: current settled virtual bankroll;
- `virtualPnl`: bankroll minus configured initial bankroll;
- `openExposure`: sum of stakes on open paper positions;
- `winRate`: wins divided by non-void settled positions;
- `averageReturn`: mean `virtualPnl / stake` across non-void settled positions;
- `maximumDrawdown` and `maximumDrawdownPercent`: settled-equity measures above;
- `signalPrecision`: share of signals with a 60-second counterfactual classified `persisted`;
- `highRuleBasedConfidenceSignals`: signals meeting the configured paper-score threshold.

Signal precision measures short-horizon movement persistence. It is not betting accuracy, an outcome probability, or evidence of future profitability.

## Reset semantics

Replay reset clears positions, processed signal IDs, sequence counters, bankroll, exposure, peak equity, and drawdown. A new replay-run prefix prevents IDs from colliding with prior append-only audit records.

## Explicit non-goals

- real betting or bookmaker accounts;
- deposits, withdrawals, or wallet custody;
- martingale or loss-chasing stake changes;
- early cash-out or exchange-style closing;
- promises of return or financial advice.
