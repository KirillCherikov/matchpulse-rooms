import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTxLineService } from "../../src/application/live-txline-service.js";
import { loadConfig, TXLINE_DEVNET_API_ORIGIN, type SentinelConfig } from "../../src/config.js";
import type { LiveFixtureObservation, LiveStreamHealth } from "../../src/domain/models.js";
import type { LiveTxLineObserver, LiveTxLineRuntimeProvider } from "../../src/providers/types.js";
import { buildServer } from "../../src/server.js";
import {
  TXLINE_DEVNET_IDL_VERSION,
  TXLINE_DEVNET_PROGRAM_ID,
  TXLINE_DEVNET_SOURCE_COMMIT,
  type FixtureProofVerifier
} from "../../src/verification/txline-fixture-verifier.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("process-wide live TxLINE runtime", () => {
  it("keeps disabled live status and readiness session-free", async () => {
    const app = await buildServer({ config: replayConfig(), serveDashboard: false });
    servers.push(app);

    for (let index = 0; index < 40; index += 1) {
      const response = await app.inject("/api/live/status");
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse(response.body)).toMatchObject({
        enabled: false,
        network: "solana-devnet",
        connected: false,
        authenticated: false,
        connectionStatus: "disabled",
        verification: { status: "unavailable" }
      });
    }

    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["set-cookie"]).toBeUndefined();
  });

  it("reports authenticated data only after the transport supplies successful observations", async () => {
    const provider = new FakeLiveProvider();
    const config = liveConfig();
    const service = new LiveTxLineService(config, provider, () => new Date(NOW));
    const app = await buildServer({ config, liveService: service, serveDashboard: false });
    servers.push(app);

    const before = await app.inject("/api/live/status");
    expect(before.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(before.body)).toMatchObject({
      enabled: true,
      connected: false,
      authenticated: false,
      connectionStatus: "connecting"
    });
    expect(provider.startCalls).toBe(1);

    provider.emitSuccessfulBootstrap();
    const after = await app.inject("/api/live/status");
    expect(after.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(after.body)).toMatchObject({
      enabled: true,
      network: "solana-devnet",
      connected: true,
      authenticated: true,
      connectionStatus: "connected",
      awaitingData: true,
      latestFixture: {
        id: "official-fixture-1",
        competition: "Official competition",
        homeTeam: "Home",
        awayTeam: "Away"
      },
      latestOddsTimestamp: NOW,
      latestScoreTimestamp: NOW,
      streams: {
        odds: { status: "connected", lastHeartbeatAt: NOW, reconnectAttempt: 0 },
        scores: { status: "connected", lastHeartbeatAt: NOW, reconnectAttempt: 0 }
      },
      verification: {
        status: "unavailable",
        reason: "No proof was supplied for this record."
      }
    });

    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["set-cookie"]).toBeUndefined();
    const replay = await app.inject("/api/agent/status");
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["set-cookie"]).toBeDefined();
    expect(JSON.parse(replay.body).mode).toBe("replay");

    await app.close();
    servers.splice(servers.indexOf(app), 1);
    expect(provider.stopCalls).toBe(1);
    expect(service.status()).toMatchObject({
      connected: false,
      authenticated: false,
      connectionStatus: "stopped"
    });
  });

  it("does not accept incomplete verification evidence or expose credential diagnostics", async () => {
    const provider = new FakeLiveProvider();
    const config = liveConfig();
    const service = new LiveTxLineService(config, provider, () => new Date(NOW));
    service.start();
    provider.observer?.onConnectionStatus(
      "disconnected",
      `Bearer ${config.txline.guestJwt} api_token=${config.txline.apiToken}`
    );
    provider.observer?.onStreamHealth("odds", {
      status: "reconnecting",
      reconnectAttempt: 2,
      error: `request token=${config.txline.apiToken}`
    });
    provider.observer?.onVerification({
      status: "verified",
      method: "simulateTransaction"
    });

    const status = service.status();
    expect(status.verification).toEqual({
      status: "unavailable",
      reason: "Verification evidence was incomplete and was not accepted."
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(config.txline.guestJwt);
    expect(serialized).not.toContain(config.txline.apiToken);
    expect(serialized).toContain("[REDACTED]");
    await service.stop();
  });

  it("accepts Verified only from the injected runtime simulation with complete current evidence", async () => {
    const provider = new FakeLiveProvider();
    const verifier: FixtureProofVerifier = {
      verifyFixture: vi.fn(async (fixture) => ({
        status: "verified" as const,
        method: "validateFixture",
        checkedAt: NOW,
        fixtureId: fixture.id,
        proofTimestamp: NOW,
        programId: TXLINE_DEVNET_PROGRAM_ID,
        rootAccount: TXLINE_DEVNET_PROGRAM_ID,
        sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
        idlVersion: TXLINE_DEVNET_IDL_VERSION,
        rpcSlot: 123,
        computeUnits: 456,
        simulation: "read-only-unsigned" as const
      }))
    };
    const service = new LiveTxLineService(liveConfig(), provider, () => new Date(NOW), verifier);
    service.start();
    provider.observer?.onFixture(officialFixture);

    await vi.waitFor(() => expect(service.status().verification.status).toBe("verified"));
    expect(service.status().verification).toMatchObject({
      method: "validateFixture",
      fixtureId: officialFixture.id,
      rpcSlot: 123,
      computeUnits: 456,
      simulation: "read-only-unsigned"
    });

    provider.observer?.onVerification({
      status: "verified",
      method: "validateFixture",
      checkedAt: NOW
    });
    expect(service.status().verification).toEqual({
      status: "unavailable",
      reason: "Verification evidence was incomplete and was not accepted."
    });
    await service.stop();
  });

  it("does not attach proof for a different fixture observation timestamp", async () => {
    const provider = new FakeLiveProvider();
    const verifier: FixtureProofVerifier = {
      verifyFixture: vi.fn(async (fixture) => ({
        status: "verified" as const,
        method: "validateFixture",
        checkedAt: "2026-07-12T00:01:01.000Z",
        fixtureId: fixture.id,
        proofTimestamp: "2026-07-12T00:01:00.000Z",
        programId: TXLINE_DEVNET_PROGRAM_ID,
        rootAccount: TXLINE_DEVNET_PROGRAM_ID,
        sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
        idlVersion: TXLINE_DEVNET_IDL_VERSION,
        rpcSlot: 123,
        computeUnits: 456,
        simulation: "read-only-unsigned" as const
      }))
    };
    const service = new LiveTxLineService(liveConfig(), provider, () => new Date(NOW), verifier);
    service.start();
    provider.observer?.onFixture(officialFixture);

    await vi.waitFor(() =>
      expect(service.status().verification.reason).toBe(
        "Verification evidence was incomplete and was not accepted."
      )
    );
    expect(service.status().verification.status).toBe("unavailable");
    await service.stop();
  });

  it("fails live configuration closed outside the exact official devnet origin", () => {
    expect(() =>
      loadConfig({
        SENTINEL_MODE: "replay",
        TXLINE_LIVE_ENABLED: "true",
        TXLINE_NETWORK: "mainnet-beta",
        TXLINE_API_ORIGIN: TXLINE_DEVNET_API_ORIGIN
      })
    ).toThrow("restricted to Solana devnet");
    expect(() =>
      loadConfig({
        SENTINEL_MODE: "replay",
        TXLINE_LIVE_ENABLED: "true",
        TXLINE_NETWORK: "devnet",
        TXLINE_API_ORIGIN: "https://example.invalid"
      })
    ).toThrow(`TXLINE_API_ORIGIN=${TXLINE_DEVNET_API_ORIGIN}`);
    expect(() =>
      loadConfig({
        SENTINEL_MODE: "live",
        TXLINE_LIVE_ENABLED: "true",
        TXLINE_NETWORK: "devnet",
        TXLINE_API_ORIGIN: TXLINE_DEVNET_API_ORIGIN
      })
    ).toThrow("requires SENTINEL_MODE=replay");
  });

  it("does not let delayed live observations regress the latest feed timestamps", async () => {
    const provider = new FakeLiveProvider();
    const service = new LiveTxLineService(liveConfig(), provider, () => new Date(NOW));
    service.start();
    const newer = "2026-07-12T00:00:30.000Z";
    const older = "2026-07-12T00:00:10.000Z";

    provider.observer?.onOddsTimestamp(newer);
    provider.observer?.onOddsTimestamp(older);
    provider.observer?.onScoreTimestamp(newer);
    provider.observer?.onScoreTimestamp(older);

    expect(service.status()).toMatchObject({
      latestOddsTimestamp: newer,
      latestScoreTimestamp: newer
    });
    await service.stop();
  });

  it("publishes a typed session-free live status contract", async () => {
    const app = await buildServer({ config: replayConfig(), serveDashboard: false });
    servers.push(app);
    const response = await app.inject("/docs/json");
    const document = JSON.parse(response.body) as {
      paths: Record<
        string,
        {
          get?: {
            responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
          };
        }
      >;
      components: { schemas: Record<string, { title?: string; required?: string[] }> };
    };
    const schema =
      document.paths["/api/live/status"]?.get?.responses["200"]?.content?.["application/json"]
        ?.schema;
    const referencedKey = schema?.$ref?.split("/").at(-1);
    expect(referencedKey).toBeDefined();
    expect(document.components.schemas[referencedKey ?? ""]?.title).toBe("LiveTxLineStatus");
    expect(document.paths["/api/live/status"]?.get?.responses["503"]).toBeUndefined();
    const liveStatus = Object.values(document.components.schemas).find(
      (candidate) => candidate.title === "LiveTxLineStatus"
    );
    expect(liveStatus?.required).toEqual(
      expect.arrayContaining([
        "enabled",
        "authenticated",
        "connectionStatus",
        "streams",
        "verification"
      ])
    );
  });
});

const NOW = "2026-07-12T00:00:00.000Z";

function replayConfig(): SentinelConfig {
  return loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" });
}

function liveConfig(): SentinelConfig {
  return loadConfig({
    SENTINEL_MODE: "replay",
    LOG_LEVEL: "silent",
    TXLINE_LIVE_ENABLED: "true",
    TXLINE_NETWORK: "devnet",
    TXLINE_API_ORIGIN: TXLINE_DEVNET_API_ORIGIN,
    TXLINE_GUEST_JWT: "synthetic-test-guest-jwt",
    TXLINE_API_TOKEN: "synthetic-test-api-token"
  });
}

class FakeLiveProvider implements LiveTxLineRuntimeProvider {
  public observer: LiveTxLineObserver | undefined;
  public startCalls = 0;
  public stopCalls = 0;

  public async start(observer: LiveTxLineObserver): Promise<void> {
    this.startCalls += 1;
    this.observer = observer;
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  public emitSuccessfulBootstrap(): void {
    const observer = this.observer;
    if (!observer) throw new Error("Live observer was not registered");
    observer.onConnectionStatus("connected");
    observer.onAuthenticated(true);
    observer.onFixture(officialFixture);
    observer.onOddsTimestamp(NOW);
    observer.onScoreTimestamp(NOW);
    const health: LiveStreamHealth = {
      status: "connected",
      lastHeartbeatAt: NOW,
      reconnectAttempt: 0
    };
    observer.onStreamHealth("odds", health);
    observer.onStreamHealth("scores", health);
    observer.onVerification({
      status: "unavailable",
      reason: "No proof was supplied for this record."
    });
  }
}

const officialFixture: LiveFixtureObservation = {
  id: "official-fixture-1",
  competition: "Official competition",
  homeTeam: "Home",
  awayTeam: "Away",
  status: "scheduled",
  scheduledStartTimestamp: NOW,
  sourceTimestamp: NOW,
  receivedTimestamp: NOW,
  rawReference: "txline://fixtures/official-fixture-1/1783814400000",
  dataLabel: "Live TxLINE devnet data"
};
