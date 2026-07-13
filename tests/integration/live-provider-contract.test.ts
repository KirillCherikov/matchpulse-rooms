import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTxLineService } from "../../src/application/live-txline-service.js";
import { loadConfig, TXLINE_DEVNET_API_ORIGIN } from "../../src/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LiveTxLineService official provider wiring", () => {
  it("constructs the real HTTP/SSE provider and exposes authenticated official observations", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer configured-guest-jwt");
      expect(headers.get("x-api-token")).toBe("configured-api-token");
      if (url.pathname === "/api/fixtures/snapshot") {
        return jsonResponse([
          {
            Ts: 1_000,
            StartTime: 2_000,
            Competition: "Official competition",
            CompetitionId: 10,
            FixtureGroupId: 20,
            Participant1Id: 101,
            Participant1: "Alpha",
            Participant2Id: 202,
            Participant2: "Beta",
            FixtureId: 42,
            Participant1IsHome: true,
            GameState: 6
          }
        ]);
      }
      if (url.pathname === "/api/odds/snapshot/42") {
        return jsonResponse([
          {
            FixtureId: 42,
            MessageId: "official-snapshot",
            Ts: 1_500,
            Bookmaker: "Official bookmaker",
            BookmakerId: 7,
            SuperOddsType: "Match Winner",
            InRunning: false,
            Prices: [10123]
          }
        ]);
      }
      if (url.pathname === "/api/scores/snapshot/42") return jsonResponse([]);
      if (url.pathname === "/api/odds/stream") {
        return hangingSse('event: heartbeat\ndata: {"Ts":1600}\n\n');
      }
      if (url.pathname === "/api/scores/stream") {
        return hangingSse('event: heartbeat\ndata: {"Ts":1601}\n\n');
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      SENTINEL_MODE: "replay",
      LOG_LEVEL: "silent",
      TXLINE_LIVE_ENABLED: "true",
      TXLINE_NETWORK: "devnet",
      TXLINE_API_ORIGIN: TXLINE_DEVNET_API_ORIGIN,
      TXLINE_GUEST_JWT: "configured-guest-jwt",
      TXLINE_API_TOKEN: "configured-api-token"
    });
    const service = LiveTxLineService.create(config);

    service.start();
    await waitFor(
      () =>
        service.status().authenticated &&
        service.status().connected &&
        Boolean(service.status().streams.odds.lastHeartbeatAt) &&
        Boolean(service.status().streams.scores.lastHeartbeatAt)
    );
    expect(service.status()).toMatchObject({
      enabled: true,
      network: "solana-devnet",
      connected: true,
      authenticated: true,
      connectionStatus: "connected",
      awaitingData: true,
      latestFixture: {
        id: "42",
        homeTeam: "Alpha",
        awayTeam: "Beta",
        status: "cancelled",
        dataLabel: "Live TxLINE devnet data"
      },
      latestOddsTimestamp: new Date(1_500).toISOString(),
      streams: {
        odds: { status: "connected", lastHeartbeatAt: expect.any(String) },
        scores: { status: "connected", lastHeartbeatAt: expect.any(String) }
      }
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/fixtures/snapshot",
        "/api/odds/snapshot/42",
        "/api/scores/snapshot/42",
        "/api/odds/stream",
        "/api/scores/stream"
      ])
    );
    await service.stop();
    expect(service.status().connectionStatus).toBe("stopped");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function hangingSse(frame: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for live service state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
