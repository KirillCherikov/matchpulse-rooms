import type {
  AgentMode,
  Fixture,
  LiveConnectionStatus,
  LiveFixtureObservation,
  LiveStreamHealth,
  ProviderMessage,
  ReplayState,
  VerificationResult
} from "../domain/models.js";

export interface TxLineProvider {
  readonly mode: AgentMode;
  fixtures(): Fixture[];
  readiness(): { ready: boolean; reason?: string };
}

export interface ControllableReplayProvider extends TxLineProvider {
  getReplayState(): ReplayState;
  start(speed?: ReplayState["speed"]): ReplayState;
  pause(): ReplayState;
  resume(): ReplayState;
  reset(): ReplayState;
  advance(): ProviderMessage | undefined;
}

/**
 * Read-only observations emitted by the official TxLINE transport. The runtime
 * sidecar owns presentation state; credentials and raw response bodies must
 * never be passed through these callbacks.
 */
export interface LiveTxLineObserver {
  onConnectionStatus(status: LiveConnectionStatus, error?: string): void;
  /** Emit `true` only after an authenticated TxLINE HTTP response succeeds. */
  onAuthenticated(authenticated: boolean): void;
  onFixture(fixture: LiveFixtureObservation): void;
  onOddsTimestamp(timestamp: string): void;
  onScoreTimestamp(timestamp: string): void;
  onStreamHealth(stream: "odds" | "scores", health: LiveStreamHealth): void;
  onVerification(result: VerificationResult): void;
  /**
   * Optional strictly normalized domain message. Official integer `Prices` and
   * unobserved `Pct` market labels are intentionally not converted or emitted.
   */
  onProviderMessage?(message: ProviderMessage): void;
}

export interface LiveTxLineRuntimeProvider {
  start(observer: LiveTxLineObserver): Promise<void>;
  stop(): Promise<void>;
}
