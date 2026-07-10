import type { Analytics, PaperPosition, SelectionKey, Signal } from "../domain/models.js";

export interface PaperTradingConfig {
  initialVirtualBankroll: number;
  stakeFraction: number;
  maxExposureFraction: number;
}

export class PaperTradingSimulator {
  private readonly positions: PaperPosition[] = [];
  private positionSequence = 0;
  private bankroll: number;
  private peakEquity: number;
  private maximumDrawdown = 0;

  public constructor(private readonly config: PaperTradingConfig) {
    this.bankroll = config.initialVirtualBankroll;
    this.peakEquity = config.initialVirtualBankroll;
  }

  public reset(): void {
    this.positions.splice(0, this.positions.length);
    this.positionSequence = 0;
    this.bankroll = this.config.initialVirtualBankroll;
    this.peakEquity = this.config.initialVirtualBankroll;
    this.maximumDrawdown = 0;
  }

  public openForSignal(signal: Signal): PaperPosition | undefined {
    if (signal.paperDecision !== "opened") {
      return undefined;
    }
    const exposure = this.openExposure();
    const cap = this.bankroll * this.config.maxExposureFraction;
    const requestedStake = this.bankroll * this.config.stakeFraction;
    const stake = Math.max(0, Math.min(requestedStake, cap - exposure, this.bankroll - exposure));
    if (stake <= 0) {
      return undefined;
    }
    this.positionSequence += 1;
    const position: PaperPosition = {
      id: `paper-${String(this.positionSequence).padStart(4, "0")}`,
      signalId: signal.id,
      fixtureId: signal.fixtureId,
      selection: signal.selection,
      status: "open",
      stake: Number(stake.toFixed(2)),
      entryOdds: signal.oddsAfter,
      openedAt: signal.receivedTimestamp,
      note: "SIMULATION ONLY — NO REAL MONEY"
    };
    this.positions.push(position);
    return position;
  }

  public settle(fixtureId: string, winner: SelectionKey, timestamp: string): PaperPosition[] {
    const settled: PaperPosition[] = [];
    for (const position of this.positions) {
      if (position.fixtureId !== fixtureId || position.status !== "open") {
        continue;
      }
      const outcome = position.selection === winner ? "won" : "lost";
      const virtualPnl =
        outcome === "won" ? position.stake * (position.entryOdds - 1) : -position.stake;
      position.status = "settled";
      position.settledAt = timestamp;
      position.outcome = outcome;
      position.virtualPnl = Number(virtualPnl.toFixed(2));
      this.bankroll = Number((this.bankroll + position.virtualPnl).toFixed(2));
      this.updateDrawdown();
      settled.push({ ...position });
    }
    return settled;
  }

  public allPositions(): PaperPosition[] {
    return this.positions.map((position) => ({ ...position }));
  }

  public analytics(signals: Signal[]): Analytics {
    const settled = this.positions.filter((position) => position.status === "settled");
    const winning = settled.filter((position) => position.outcome === "won");
    const pnl = this.bankroll - this.config.initialVirtualBankroll;
    const returns = settled.map((position) => (position.virtualPnl ?? 0) / position.stake);
    const highConfidence = signals.filter((signal) => signal.confidence >= 0.72);
    const highConfidenceWithOutcomes = highConfidence.filter(
      (signal) => signal.outcome?.positionOutcome
    );
    const successfulSignals = highConfidenceWithOutcomes.filter(
      (signal) => signal.outcome?.positionOutcome === "won"
    );
    return {
      virtualBankroll: this.bankroll,
      virtualPnl: Number(pnl.toFixed(2)),
      openExposure: this.openExposure(),
      settledPositions: settled.length,
      winRate: settled.length === 0 ? 0 : winning.length / settled.length,
      averageReturn:
        returns.length === 0 ? 0 : returns.reduce((sum, value) => sum + value, 0) / returns.length,
      maximumDrawdown: this.maximumDrawdown,
      maximumDrawdownPercent:
        this.peakEquity === 0 ? 0 : Number((this.maximumDrawdown / this.peakEquity).toFixed(4)),
      signalPrecision:
        highConfidenceWithOutcomes.length === 0
          ? 0
          : successfulSignals.length / highConfidenceWithOutcomes.length,
      highConfidenceSignals: highConfidence.length
    };
  }

  private openExposure(): number {
    return Number(
      this.positions
        .filter((position) => position.status === "open")
        .reduce((sum, position) => sum + position.stake, 0)
        .toFixed(2)
    );
  }

  private updateDrawdown(): void {
    this.peakEquity = Math.max(this.peakEquity, this.bankroll);
    this.maximumDrawdown = Math.max(this.maximumDrawdown, this.peakEquity - this.bankroll);
  }
}
