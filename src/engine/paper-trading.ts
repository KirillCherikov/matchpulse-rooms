import type {
  Analytics,
  PaperPosition,
  PositionOutcome,
  SelectionKey,
  Signal
} from "../domain/models.js";
import { MAX_DECIMAL_ODDS } from "../domain/constraints.js";

export interface PaperTradingConfig {
  initialVirtualBankroll: number;
  stakeFraction: number;
  maxExposureFraction: number;
  minRuleBasedConfidenceToTrade: number;
}

export class PaperTradingSimulator {
  private readonly positions: PaperPosition[] = [];
  private positionSequence = 0;
  private readonly processedSignalIds = new Set<string>();
  private idPrefix = "simulation";
  private bankroll: number;
  private peakEquity: number;
  private maximumDrawdown = 0;
  private maximumDrawdownPercent = 0;

  public constructor(private readonly config: PaperTradingConfig) {
    if (!Number.isFinite(config.initialVirtualBankroll) || config.initialVirtualBankroll <= 0) {
      throw new Error("Initial virtual bankroll must be a positive finite number");
    }
    if (
      !Number.isFinite(config.stakeFraction) ||
      config.stakeFraction <= 0 ||
      config.stakeFraction > 1
    ) {
      throw new Error("Stake fraction must be greater than zero and at most one");
    }
    if (
      !Number.isFinite(config.maxExposureFraction) ||
      config.maxExposureFraction <= 0 ||
      config.maxExposureFraction > 1
    ) {
      throw new Error("Maximum exposure fraction must be greater than zero and at most one");
    }
    this.bankroll = config.initialVirtualBankroll;
    this.peakEquity = config.initialVirtualBankroll;
  }

  public reset(idPrefix = this.idPrefix): void {
    this.positions.splice(0, this.positions.length);
    this.positionSequence = 0;
    this.processedSignalIds.clear();
    this.bankroll = this.config.initialVirtualBankroll;
    this.peakEquity = this.config.initialVirtualBankroll;
    this.maximumDrawdown = 0;
    this.maximumDrawdownPercent = 0;
    this.idPrefix = idPrefix;
  }

  public openForSignal(signal: Signal): PaperPosition | undefined {
    if (signal.paperDecision !== "eligible" || this.processedSignalIds.has(signal.id)) {
      return undefined;
    }
    this.processedSignalIds.add(signal.id);
    if (
      !Number.isFinite(signal.oddsAfter) ||
      signal.oddsAfter <= 1 ||
      signal.oddsAfter > MAX_DECIMAL_ODDS
    ) {
      return undefined;
    }
    const exposure = this.openExposure();
    const cap = this.bankroll * this.config.maxExposureFraction;
    const requestedStake = this.bankroll * this.config.stakeFraction;
    const stake = Number(
      Math.max(0, Math.min(requestedStake, cap - exposure, this.bankroll - exposure)).toFixed(2)
    );
    if (stake <= 0) {
      return undefined;
    }
    this.positionSequence += 1;
    const position: PaperPosition = {
      id: `${this.idPrefix}:paper-${String(this.positionSequence).padStart(4, "0")}`,
      signalId: signal.id,
      fixtureId: signal.fixtureId,
      selection: signal.selection,
      status: "open",
      stake,
      entryOdds: signal.oddsAfter,
      openedAt: signal.receivedTimestamp,
      note: "SIMULATION ONLY — NO REAL MONEY"
    };
    this.positions.push(position);
    return position;
  }

  public settle(
    fixtureId: string,
    result: SelectionKey | "void",
    timestamp: string
  ): PaperPosition[] {
    const projections = this.positions
      .filter((position) => position.fixtureId === fixtureId && position.status === "open")
      .map((position) => {
        const outcome: PositionOutcome =
          result === "void" ? "void" : position.selection === result ? "won" : "lost";
        const virtualPnl =
          outcome === "void"
            ? 0
            : outcome === "won"
              ? position.stake * (position.entryOdds - 1)
              : -position.stake;
        if (!Number.isFinite(virtualPnl)) {
          throw new Error("Paper settlement produced a non-finite virtual P&L");
        }
        return { position, outcome, virtualPnl: Number(virtualPnl.toFixed(2)) };
      });
    const aggregatePnl = projections.reduce((sum, projection) => sum + projection.virtualPnl, 0);
    const nextBankroll = Number((this.bankroll + aggregatePnl).toFixed(2));
    if (!Number.isFinite(nextBankroll)) {
      throw new Error("Paper settlement produced a non-finite virtual bankroll");
    }
    const settled: PaperPosition[] = [];
    for (const { position, outcome, virtualPnl } of projections) {
      position.status = "settled";
      position.settledAt = timestamp;
      position.outcome = outcome;
      position.virtualPnl = virtualPnl;
      settled.push({ ...position });
    }
    if (settled.length > 0) {
      this.bankroll = nextBankroll;
      this.updateDrawdown();
    }
    return settled;
  }

  public allPositions(): PaperPosition[] {
    return this.positions.map((position) => ({ ...position }));
  }

  public analytics(signals: Signal[]): Analytics {
    const settled = this.positions.filter((position) => position.status === "settled");
    const decided = settled.filter((position) => position.outcome !== "void");
    const winning = decided.filter((position) => position.outcome === "won");
    const pnl = this.bankroll - this.config.initialVirtualBankroll;
    const returns = decided.map((position) => (position.virtualPnl ?? 0) / position.stake);
    const highConfidence = signals.filter(
      (signal) => signal.ruleBasedConfidenceScore >= this.config.minRuleBasedConfidenceToTrade
    );
    const evaluatedSignals = signals
      .map((signal) => signal.counterfactual.horizons.find((point) => point.horizonSeconds === 60))
      .filter((point) => point !== undefined);
    const persistentSignals = evaluatedSignals.filter(
      (point) => point.classification === "persisted"
    );
    return {
      virtualBankroll: this.bankroll,
      virtualPnl: Number(pnl.toFixed(2)),
      openExposure: this.openExposure(),
      settledPositions: settled.length,
      winRate: decided.length === 0 ? 0 : winning.length / decided.length,
      averageReturn:
        returns.length === 0 ? 0 : returns.reduce((sum, value) => sum + value, 0) / returns.length,
      maximumDrawdown: this.maximumDrawdown,
      maximumDrawdownPercent: this.maximumDrawdownPercent,
      signalPrecision:
        evaluatedSignals.length === 0 ? 0 : persistentSignals.length / evaluatedSignals.length,
      highRuleBasedConfidenceSignals: highConfidence.length
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
    const currentDrawdown = this.peakEquity - this.bankroll;
    const currentDrawdownPercent = this.peakEquity === 0 ? 0 : currentDrawdown / this.peakEquity;
    this.maximumDrawdown = Math.max(this.maximumDrawdown, currentDrawdown);
    this.maximumDrawdownPercent = Math.max(
      this.maximumDrawdownPercent,
      Number(currentDrawdownPercent.toFixed(4))
    );
  }
}
