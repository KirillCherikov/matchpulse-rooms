import type { SentinelConfig } from "../config.js";
import type {
  LiveConnectionStatus,
  LiveFixtureObservation,
  LiveStreamHealth,
  LiveTxLineStatus,
  ProviderMessage,
  VerificationResult
} from "../domain/models.js";
import { LiveTxLineProvider } from "../providers/live.js";
import type { LiveTxLineObserver, LiveTxLineRuntimeProvider } from "../providers/types.js";
import {
  TXLINE_DEVNET_IDL_VERSION,
  TXLINE_DEVNET_PROGRAM_ID,
  TXLINE_DEVNET_SOURCE_COMMIT,
  TxLineFixtureVerifier,
  type FixtureProofVerifier
} from "../verification/txline-fixture-verifier.js";

export interface LiveTxLineStatusService {
  start(): void;
  stop(): Promise<void>;
  status(): LiveTxLineStatus;
}

/**
 * One process-wide, read-only view of the official TxLINE devnet transport.
 * It is deliberately separate from anonymous replay agents: live observations
 * never open paper positions, move replay cursors, or allocate session cookies.
 */
export class LiveTxLineService implements LiveTxLineStatusService {
  private current: LiveTxLineStatus;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private stopping = false;
  private verificationController: AbortController | undefined;
  private verificationPromise: Promise<void> | undefined;
  private verificationGeneration = 0;

  public constructor(
    private readonly config: SentinelConfig,
    private readonly provider?: LiveTxLineRuntimeProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly verifier?: FixtureProofVerifier
  ) {
    this.current = this.initialStatus();
  }

  public static create(config: SentinelConfig): LiveTxLineService {
    if (!config.txline.liveEnabled) return new LiveTxLineService(config);
    const { apiOrigin, guestJwt, apiToken } = config.txline;
    if (!apiOrigin || !guestJwt || !apiToken) return new LiveTxLineService(config);

    const provider = new LiveTxLineProvider({
      enabled: true,
      apiOrigin,
      guestJwt,
      apiToken,
      maxRetainedMessages: config.txline.maxRetainedMessages,
      requestTimeoutMs: config.txline.requestTimeoutMs,
      idleTimeoutMs: config.txline.streamIdleTimeoutMs,
      retryInitialDelayMs: config.txline.retryInitialDelayMs,
      retryMaxDelayMs: config.txline.retryMaxDelayMs,
      maxReconnectAttempts: config.txline.maxReconnectAttempts
    });
    const verifier = new TxLineFixtureVerifier({
      apiOrigin,
      guestJwt,
      apiToken,
      requestTimeoutMs: config.txline.requestTimeoutMs
    });
    return new LiveTxLineService(config, provider, () => new Date(), verifier);
  }

  /** Starts transport work in the background so replay readiness never waits on TxLINE. */
  public start(): void {
    if (this.started || !this.config.txline.liveEnabled) return;
    this.started = true;
    this.stopping = false;
    if (!this.provider) {
      this.update({
        connected: false,
        authenticated: false,
        connectionStatus: "disconnected",
        lastError: "TxLINE live credentials are not configured."
      });
      return;
    }

    this.update({
      connected: false,
      authenticated: false,
      connectionStatus: "connecting",
      streams: {
        odds: this.streamWithStatus("odds", "connecting"),
        scores: this.streamWithStatus("scores", "connecting")
      }
    });
    this.startPromise = this.provider.start(this.observer()).catch((error: unknown) => {
      if (this.stopping) return;
      const diagnostic = this.safeDiagnostic(error);
      this.update({
        connected: false,
        connectionStatus: "disconnected",
        lastError: diagnostic,
        streams: {
          odds: this.streamWithStatus("odds", "disconnected", diagnostic),
          scores: this.streamWithStatus("scores", "disconnected", diagnostic)
        }
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.config.txline.liveEnabled) return;
    if (this.stopping || this.current.connectionStatus === "stopped") return;
    this.stopping = true;
    this.verificationGeneration += 1;
    this.verificationController?.abort();
    try {
      await this.provider?.stop();
      await this.startPromise;
      await this.verificationPromise;
    } catch (error) {
      this.update({ lastError: this.safeDiagnostic(error) });
    } finally {
      this.started = false;
      this.verificationController = undefined;
      this.verificationPromise = undefined;
      this.update({
        connected: false,
        authenticated: false,
        connectionStatus: "stopped",
        streams: {
          odds: this.streamWithStatus("odds", "stopped"),
          scores: this.streamWithStatus("scores", "stopped")
        }
      });
    }
  }

  public status(): LiveTxLineStatus {
    return structuredClone(this.current);
  }

  private observer(): LiveTxLineObserver {
    const onVerification = (result: VerificationResult, trustedRuntimeVerifier = false) => {
      this.update({ verification: this.safeVerification(result, trustedRuntimeVerifier) });
    };
    return {
      onConnectionStatus: (status, error) => {
        const diagnostic = error ? this.safeDiagnostic(error) : undefined;
        this.update({
          connected: status === "connected",
          connectionStatus: status,
          ...(diagnostic ? { lastError: diagnostic } : {})
        });
      },
      onAuthenticated: (authenticated) => {
        this.update({ authenticated });
      },
      onFixture: (fixture) => {
        this.update({ latestFixture: this.safeFixture(fixture) });
        this.scheduleFixtureVerification(fixture, (result) => onVerification(result, true));
      },
      onOddsTimestamp: (value) => {
        const timestamp = this.safeTimestamp(value, "odds");
        if (timestamp) {
          this.update({
            latestOddsTimestamp: this.latestTimestamp(this.current.latestOddsTimestamp, timestamp)
          });
        }
      },
      onScoreTimestamp: (value) => {
        const timestamp = this.safeTimestamp(value, "score");
        if (timestamp) {
          this.update({
            latestScoreTimestamp: this.latestTimestamp(this.current.latestScoreTimestamp, timestamp)
          });
        }
      },
      onStreamHealth: (stream, health) => {
        this.update({
          streams: {
            ...this.current.streams,
            [stream]: this.safeStreamHealth(health)
          }
        });
      },
      onVerification: (result) => {
        onVerification(result);
      },
      onProviderMessage: (message) => this.observeMessage(message)
    };
  }

  private scheduleFixtureVerification(
    fixture: LiveFixtureObservation,
    onVerification: (result: VerificationResult) => void
  ): void {
    if (!this.verifier || this.stopping) return;
    this.verificationGeneration += 1;
    const generation = this.verificationGeneration;
    this.verificationController?.abort();
    const controller = new AbortController();
    this.verificationController = controller;
    this.update({
      verification: {
        status: "unavailable",
        method: "validateFixture",
        fixtureId: fixture.id,
        programId: TXLINE_DEVNET_PROGRAM_ID,
        sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
        idlVersion: TXLINE_DEVNET_IDL_VERSION,
        simulation: "read-only-unsigned",
        reason: "Fixture proof verification is pending."
      }
    });
    const verification = this.verifier
      .verifyFixture(structuredClone(fixture), controller.signal)
      .then((result) => {
        if (
          controller.signal.aborted ||
          this.stopping ||
          generation !== this.verificationGeneration ||
          this.current.latestFixture?.id !== fixture.id
        ) {
          return;
        }
        onVerification(result);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          this.stopping ||
          generation !== this.verificationGeneration
        ) {
          return;
        }
        onVerification({
          status: "unavailable",
          method: "validateFixture",
          checkedAt: this.nowIso(),
          fixtureId: fixture.id,
          programId: TXLINE_DEVNET_PROGRAM_ID,
          sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
          idlVersion: TXLINE_DEVNET_IDL_VERSION,
          simulation: "read-only-unsigned",
          reason: `Fixture verifier failed safely: ${this.safeDiagnostic(error)}`
        });
      })
      .finally(() => {
        if (this.verificationPromise === verification) this.verificationPromise = undefined;
        if (this.verificationController === controller) this.verificationController = undefined;
      });
    this.verificationPromise = verification;
  }

  private observeMessage(message: ProviderMessage): void {
    if (message.kind === "odds") {
      const timestamp = this.safeTimestamp(message.sourceTimestamp, "odds");
      if (timestamp) {
        this.update({
          latestOddsTimestamp: this.latestTimestamp(this.current.latestOddsTimestamp, timestamp)
        });
      }
      return;
    }
    if (!message.confirmed) return;
    const timestamp = this.safeTimestamp(message.sourceTimestamp, "score");
    if (timestamp) {
      this.update({
        latestScoreTimestamp: this.latestTimestamp(this.current.latestScoreTimestamp, timestamp)
      });
    }
  }

  private initialStatus(): LiveTxLineStatus {
    const enabled = this.config.txline.liveEnabled;
    const status: LiveConnectionStatus = enabled ? "disconnected" : "disabled";
    const unavailableReason = enabled
      ? "No successful on-chain verification has been reported."
      : "Live TxLINE devnet is disabled in this runtime.";
    return {
      enabled,
      network: "solana-devnet",
      connected: false,
      authenticated: false,
      connectionStatus: status,
      awaitingData: true,
      streams: {
        odds: this.emptyStream(status),
        scores: this.emptyStream(status)
      },
      verification: { status: "unavailable", reason: unavailableReason },
      ...(!enabled
        ? {}
        : !this.provider
          ? { lastError: "TxLINE live credentials are not configured." }
          : {}),
      updatedAt: this.nowIso()
    };
  }

  private safeFixture(fixture: LiveFixtureObservation): LiveFixtureObservation {
    return structuredClone(fixture);
  }

  private safeStreamHealth(health: LiveStreamHealth): LiveStreamHealth {
    return {
      status: health.status,
      reconnectAttempt: Math.max(0, Math.trunc(health.reconnectAttempt)),
      ...(health.lastHeartbeatAt && this.validTimestamp(health.lastHeartbeatAt)
        ? { lastHeartbeatAt: health.lastHeartbeatAt }
        : {}),
      ...(health.lastEventAt && this.validTimestamp(health.lastEventAt)
        ? { lastEventAt: health.lastEventAt }
        : {}),
      ...(health.error ? { error: this.safeDiagnostic(health.error) } : {})
    };
  }

  private safeVerification(
    result: VerificationResult,
    trustedRuntimeVerifier = false
  ): VerificationResult {
    if (
      result.status === "verified" &&
      (!trustedRuntimeVerifier || !this.completeVerifiedEvidence(result))
    ) {
      return {
        status: "unavailable",
        reason: "Verification evidence was incomplete and was not accepted."
      };
    }
    if (result.checkedAt && !this.validTimestamp(result.checkedAt)) {
      return {
        status: "failed",
        ...(result.method ? { method: result.method } : {}),
        reason: "Verification returned an invalid timestamp."
      };
    }
    return {
      status: result.status,
      ...(result.method ? { method: result.method } : {}),
      ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
      ...(result.reason ? { reason: this.safeDiagnostic(result.reason) } : {}),
      ...(result.fixtureId ? { fixtureId: result.fixtureId.slice(0, 128) } : {}),
      ...(result.proofTimestamp && this.validTimestamp(result.proofTimestamp)
        ? { proofTimestamp: result.proofTimestamp }
        : {}),
      ...(result.programId ? { programId: result.programId.slice(0, 64) } : {}),
      ...(result.rootAccount ? { rootAccount: result.rootAccount.slice(0, 64) } : {}),
      ...(result.sourceCommit ? { sourceCommit: result.sourceCommit.slice(0, 40) } : {}),
      ...(result.idlVersion ? { idlVersion: result.idlVersion.slice(0, 32) } : {}),
      ...(result.rpcSlot !== undefined &&
      Number.isSafeInteger(result.rpcSlot) &&
      result.rpcSlot >= 0
        ? { rpcSlot: result.rpcSlot }
        : {}),
      ...(result.computeUnits !== undefined &&
      Number.isSafeInteger(result.computeUnits) &&
      result.computeUnits >= 0 &&
      result.computeUnits <= 1_000_000
        ? { computeUnits: result.computeUnits }
        : {}),
      ...(result.simulation === "read-only-unsigned" ? { simulation: result.simulation } : {})
    };
  }

  private completeVerifiedEvidence(result: VerificationResult): boolean {
    const latestFixture = this.current.latestFixture;
    if (
      result.method !== "validateFixture" ||
      !result.checkedAt ||
      !this.validTimestamp(result.checkedAt) ||
      !latestFixture ||
      !result.fixtureId ||
      result.fixtureId !== latestFixture.id ||
      !result.proofTimestamp ||
      !this.validTimestamp(result.proofTimestamp) ||
      result.proofTimestamp !== latestFixture.sourceTimestamp ||
      result.programId !== TXLINE_DEVNET_PROGRAM_ID ||
      !result.rootAccount ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.rootAccount) ||
      result.sourceCommit !== TXLINE_DEVNET_SOURCE_COMMIT ||
      result.idlVersion !== TXLINE_DEVNET_IDL_VERSION ||
      result.simulation !== "read-only-unsigned" ||
      !Number.isSafeInteger(result.rpcSlot) ||
      (result.rpcSlot ?? -1) < 0 ||
      !Number.isSafeInteger(result.computeUnits) ||
      (result.computeUnits ?? -1) < 0 ||
      (result.computeUnits ?? 1_000_001) > 1_000_000
    ) {
      return false;
    }
    const checkedAt = new Date(result.checkedAt).getTime();
    const proofTimestamp = new Date(result.proofTimestamp).getTime();
    return proofTimestamp <= checkedAt + 300_000;
  }

  private safeTimestamp(value: string, feed: "odds" | "score"): string | undefined {
    if (this.validTimestamp(value)) return value;
    this.update({ lastError: `TxLINE ${feed} timestamp was invalid and was ignored.` });
    return undefined;
  }

  private validTimestamp(value: string): boolean {
    return Number.isFinite(new Date(value).getTime());
  }

  private latestTimestamp(current: string | undefined, candidate: string): string {
    if (!current) return candidate;
    return new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current;
  }

  private emptyStream(status: LiveConnectionStatus): LiveStreamHealth {
    return { status, reconnectAttempt: 0 };
  }

  private streamWithStatus(
    stream: "odds" | "scores",
    status: LiveConnectionStatus,
    error?: string
  ): LiveStreamHealth {
    const previous = status === "connecting" ? undefined : this.current.streams[stream];
    return {
      status,
      reconnectAttempt: previous?.reconnectAttempt ?? 0,
      ...(previous?.lastHeartbeatAt ? { lastHeartbeatAt: previous.lastHeartbeatAt } : {}),
      ...(previous?.lastEventAt ? { lastEventAt: previous.lastEventAt } : {}),
      ...(error ? { error } : {})
    };
  }

  private update(patch: Partial<LiveTxLineStatus>): void {
    const next = {
      ...this.current,
      ...patch,
      updatedAt: this.nowIso()
    };
    this.current = {
      ...next,
      awaitingData: !next.streams.odds.lastEventAt && !next.streams.scores.lastEventAt
    };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private safeDiagnostic(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [this.config.txline.guestJwt, this.config.txline.apiToken]) {
      if (secret) message = message.replaceAll(secret, "[REDACTED]");
    }
    message = message
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|api[_-]?token|jwt|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/[\r\n\t]+/g, " ")
      .trim();
    return (message || "TxLINE transport error").slice(0, 240);
  }
}
