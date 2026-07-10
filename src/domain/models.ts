export const SYNTHETIC_DEMO_LABEL = "Synthetic demo data — not a real match";

export type AgentMode = "replay" | "mock" | "live";
export type FeedKind = "odds" | "score";
export type FixtureStatus = "scheduled" | "live" | "finished" | "cancelled";
export type MarketKey = "match_winner";
export type SelectionKey = "home" | "draw" | "away";
export type MatchEventType =
  | "kickoff"
  | "goal"
  | "red_card"
  | "penalty"
  | "var"
  | "half_time"
  | "full_time"
  | "extra_time"
  | "shootout"
  | "postponed"
  | "cancelled";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertType =
  | "stale_feed"
  | "duplicate_update"
  | "out_of_order_update"
  | "sequence_gap"
  | "delayed_update"
  | "feed_recovery"
  | "odds_score_divergence"
  | "malformed_payload";
export type ReplayStatus = "idle" | "running" | "paused" | "finished";
export type PaperPositionStatus = "open" | "settled";
export type PaperDecision = "opened" | "declined" | "not_eligible";
export type PositionOutcome = "won" | "lost" | "void";

export interface Fixture {
  id: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  status: FixtureStatus;
  score: { home: number; away: number };
  minute: number;
  dataLabel?: string;
}

export interface OddsSelection {
  selection: SelectionKey;
  decimalOdds: number;
}

export interface OddsUpdate {
  kind: "odds";
  id: string;
  fixtureId: string;
  market: MarketKey;
  sequence: number;
  sourceTimestamp: string;
  receivedTimestamp: string;
  selections: OddsSelection[];
  rawReference: string;
}

export interface MatchEvent {
  kind: "score";
  id: string;
  fixtureId: string;
  sequence: number;
  sourceTimestamp: string;
  receivedTimestamp: string;
  type: MatchEventType;
  minute: number;
  team?: "home" | "away";
  score?: { home: number; away: number };
  confirmed: boolean;
  rawReference: string;
}

export type ProviderMessage = OddsUpdate | MatchEvent;

export interface NormalizedOddsSelection extends OddsSelection {
  impliedProbability: number;
  normalizedProbability: number;
}

export interface NormalizedOddsSnapshot extends Omit<OddsUpdate, "selections"> {
  selections: NormalizedOddsSelection[];
  overround: number;
}

export interface RollingBaseline {
  sampleSize: number;
  meanAbsoluteMovement: number;
  standardDeviation: number;
  volatility: number;
}

export interface MovementMetrics {
  probabilityDelta: number;
  percentagePointMovement: number;
  velocityPerSecond: number;
  accelerationPerSecondSquared: number;
  rollingBaseline: RollingBaseline;
}

export interface CorrelatedEvent {
  event: MatchEvent;
  distanceMs: number;
}

export interface OperationalAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  fixtureId: string;
  feed: FeedKind;
  timestamp: string;
  message: string;
  correlationId: string;
  metadata: Record<string, string | number | boolean>;
}

export interface SignalExplanation {
  summary: string;
  confirmedEvent?: string;
  dataQuality: string;
  decision: string;
  reasons: string[];
}

export interface CounterfactualPoint {
  horizonSeconds: number;
  observedAt: string;
  normalizedProbability: number;
  probabilityDelta: number;
  classification: "persisted" | "reversed" | "inconclusive";
}

export interface CounterfactualEvaluation {
  horizons: CounterfactualPoint[];
  immediateEntryOdds: number;
  confirmationEntryOdds?: number;
  movementPersisted?: boolean;
}

export interface SignalOutcome {
  settledAt: string;
  positionOutcome?: PositionOutcome;
  virtualPnl?: number;
}

export interface Signal {
  id: string;
  correlationId: string;
  fixtureId: string;
  competition: string;
  market: MarketKey;
  selection: SelectionKey;
  sourceTimestamp: string;
  receivedTimestamp: string;
  matchMinute: number;
  oddsBefore: number;
  oddsAfter: number;
  impliedProbabilityBefore: number;
  impliedProbabilityAfter: number;
  normalizedProbabilityBefore: number;
  normalizedProbabilityAfter: number;
  movement: MovementMetrics;
  correlatedEvent?: CorrelatedEvent;
  latencyMs: number;
  confidence: number;
  triggeredRules: string[];
  explanation: SignalExplanation;
  paperDecision: PaperDecision;
  strategyConfigurationVersion: string;
  counterfactual: CounterfactualEvaluation;
  outcome?: SignalOutcome;
}

export interface PaperPosition {
  id: string;
  signalId: string;
  fixtureId: string;
  selection: SelectionKey;
  status: PaperPositionStatus;
  stake: number;
  entryOdds: number;
  openedAt: string;
  settledAt?: string;
  outcome?: PositionOutcome;
  virtualPnl?: number;
  note: "SIMULATION ONLY — NO REAL MONEY";
}

export interface Analytics {
  virtualBankroll: number;
  virtualPnl: number;
  openExposure: number;
  settledPositions: number;
  winRate: number;
  averageReturn: number;
  maximumDrawdown: number;
  maximumDrawdownPercent: number;
  signalPrecision: number;
  highConfidenceSignals: number;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  correlationId: string;
  type:
    | "replay_control"
    | "raw_input_reference"
    | "normalized_input"
    | "operational_alert"
    | "signal_decision"
    | "paper_execution"
    | "settlement"
    | "recovery"
    | "error";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ReplayState {
  status: ReplayStatus;
  speed: 1 | 2 | 5 | 10;
  cursor: number;
  totalEvents: number;
  simulatedTime?: string;
}

export interface AgentStatus {
  mode: AgentMode;
  ready: boolean;
  replay?: ReplayState;
  fixture?: Fixture;
  latestSignal?: Signal;
  latestAlert?: OperationalAlert;
  latestEvent?: MatchEvent;
  latestOdds?: NormalizedOddsSnapshot;
  auditEvents: number;
  disclaimer: "SIMULATION ONLY — NO REAL MONEY";
}
