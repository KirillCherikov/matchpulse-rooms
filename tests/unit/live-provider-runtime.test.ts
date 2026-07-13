import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LiveConnectionStatus,
  LiveFixtureObservation,
  LiveStreamHealth,
  ProviderMessage,
  VerificationResult
} from "../../src/domain/models.js";
import {
  historicalOddsBucketPath,
  LiveTxLineProvider,
  type LiveTxLineProviderOptions
} from "../../src/providers/live.js";
import { SseParser } from "../../src/providers/sse-parser.js";
import { adaptTxLineFixture } from "../../src/providers/txline-adapter.js";
import {
  txLineFixtureSchema,
  txLineOddsSchema,
  txLineScoreSchema
} from "../../src/providers/txline-schemas.js";
import type { LiveTxLineObserver } from "../../src/providers/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("official TxLINE live transport", () => {
  it("parses arbitrarily fragmented UTF-8 SSE frames", () => {
    const parser = new SseParser();
    const bytes = new TextEncoder().encode('id: 100:1\ndata: {"book":"Café"}\n\n');
    const splitInsideMultibyteCharacter = bytes.indexOf(0xc3) + 1;

    expect(parser.push(bytes.slice(0, 3))).toEqual([]);
    expect(parser.push(bytes.slice(3, splitInsideMultibyteCharacter))).toEqual([]);
    expect(parser.push(bytes.slice(splitInsideMultibyteCharacter))).toEqual([
      {
        id: "100:1",
        data: '{"book":"Café"}',
        comments: []
      }
    ]);

    const crlfParser = new SseParser();
    expect(crlfParser.push("id: 101:1\r")).toEqual([]);
    expect(crlfParser.push('\ndata: {"ok":true}\r')).toEqual([]);
    expect(crlfParser.push("\n\r")).toEqual([]);
    expect(crlfParser.push("\n")).toEqual([{ id: "101:1", data: '{"ok":true}', comments: [] }]);

    const bomParser = new SseParser();
    const bomFrame = new TextEncoder().encode("\uFEFFdata: split-bom\n\n");
    expect(bomParser.push(bomFrame.slice(0, 1))).toEqual([]);
    expect(bomParser.push(bomFrame.slice(1, 2))).toEqual([]);
    expect(bomParser.push(bomFrame.slice(2))).toEqual([{ data: "split-bom", comments: [] }]);
  });

  it("applies one absolute deadline to a slow-drip JSON snapshot body", async () => {
    let chunks = 0;
    const provider = new LiveTxLineProvider(
      options(
        async (input) => {
          const path = new URL(input).pathname;
          if (path === "/api/fixtures/snapshot") {
            return slowDripJson(() => {
              chunks += 1;
            });
          }
          throw new Error(`Unexpected test path ${path}`);
        },
        { requestTimeoutMs: 100, maxReconnectAttempts: 0 }
      )
    );
    const running = provider.start(new RecordingObserver());

    try {
      const error = await rejectionWithin(running, 750);
      expect(String(error)).toContain("TxLINE response body timed out");
      expect(chunks).toBeGreaterThan(1);
    } finally {
      await provider.stop();
      await running.catch(() => undefined);
    }
  });

  it("bootstraps official snapshots, consumes fragmented streams, and preserves integer odds", async () => {
    const requests: Array<{ path: string; headers: Record<string, string>; signal: AbortSignal }> =
      [];
    let cancelledStreams = 0;
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      requests.push({
        path,
        headers: headersRecord(init.headers),
        signal: init.signal as AbortSignal
      });
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path === "/api/odds/snapshot/42") return jsonResponse([officialOdds("snapshot", 1_000)]);
      if (path === "/api/scores/snapshot/42") return jsonResponse([]);
      if (path === "/api/odds/stream") {
        return hangingSse(
          [
            "event: heart",
            'beat\ndata: {"Ts":1001}\n\nid: 1001:0\nda',
            `ta: ${JSON.stringify(officialOdds("stream", 1_001))}\n\n`
          ],
          () => {
            cancelledStreams += 1;
          }
        );
      }
      if (path === "/api/scores/stream") {
        return hangingSse(
          ["id: 1002", `:0\ndata: ${JSON.stringify(officialGoal(1, 1_002))}\n\n`],
          () => {
            cancelledStreams += 1;
          }
        );
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch, { maxRetainedMessages: 3 }));
    const running = provider.start(observer);

    await waitFor(() => provider.receivedOfficialRecords().length === 3);
    expect(provider.observedFixtures()).toEqual([
      expect.objectContaining({ id: "42", homeTeam: "Alpha", awayTeam: "Beta" })
    ]);
    expect(provider.receivedOfficialRecords()).toHaveLength(3);
    const oddsRecords = provider
      .receivedOfficialRecords()
      .filter((record) => record.feed === "odds");
    expect(oddsRecords).toHaveLength(2);
    expect(oddsRecords[1]?.record.Prices).toEqual([10123, 20234, 30345]);
    expect(provider.receivedMessages()).toEqual([
      expect.objectContaining({ kind: "score", type: "goal", fixtureId: "42" })
    ]);
    expect(observer.messages.some((message) => message.kind === "odds")).toBe(false);
    expect(observer.oddsTimestamps).toEqual([
      new Date(1_000).toISOString(),
      new Date(1_001).toISOString()
    ]);
    expect(observer.scoreTimestamps).toEqual([new Date(1_002).toISOString()]);
    expect(observer.health.odds).toMatchObject({
      status: "connected",
      lastHeartbeatAt: NOW,
      lastEventAt: NOW
    });
    expect(
      requests.every((request) => request.headers.authorization === "Bearer guest-jwt-value")
    ).toBe(true);
    expect(requests.every((request) => request.headers["x-api-token"] === "api-token-value")).toBe(
      true
    );
    expect(observer.connections.some(({ status }) => status === "connected")).toBe(true);

    await provider.stop();
    await running;
    expect(cancelledStreams).toBe(2);
    expect(
      requests
        .filter((request) => request.path.endsWith("/stream"))
        .every((request) => request.signal.aborted)
    ).toBe(true);
  });

  it("renews an expired guest JWT once and retries with the same API token", async () => {
    const authorizations: string[] = [];
    let fixtureRequests = 0;
    let renewalRequests = 0;
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      const headers = headersRecord(init.headers);
      if (path === "/auth/guest/start") {
        renewalRequests += 1;
        expect(init.method).toBe("POST");
        expect(headers.authorization).toBeUndefined();
        return jsonResponse({ token: "renewed-guest-jwt-value" });
      }
      authorizations.push(headers.authorization ?? "");
      expect(headers["x-api-token"]).toBe("api-token-value");
      if (path === "/api/fixtures/snapshot") {
        fixtureRequests += 1;
        return fixtureRequests === 1
          ? new Response(null, { status: 401 })
          : jsonResponse([officialFixture()]);
      }
      if (path.startsWith("/api/odds/snapshot/") || path.startsWith("/api/scores/snapshot/")) {
        return jsonResponse([]);
      }
      if (path.endsWith("/stream")) return hangingSse([]);
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch));
    const running = provider.start(observer);

    await waitFor(() => observer.authenticated.includes(true));
    expect(renewalRequests).toBe(1);
    expect(fixtureRequests).toBe(2);
    expect(authorizations).toContain("Bearer guest-jwt-value");
    expect(authorizations).toContain("Bearer renewed-guest-jwt-value");
    expect(observer.authenticated).toContain(false);
    await provider.stop();
    await running;
  });

  it("retries a transient bootstrap failure without publishing partial state", async () => {
    let fixtureRequests = 0;
    const delays: number[] = [];
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") {
        fixtureRequests += 1;
        return fixtureRequests === 1
          ? new Response(null, { status: 500 })
          : jsonResponse([officialFixture()]);
      }
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path.endsWith("/stream")) return hangingSse([]);
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(
      options(fetch, {
        maxReconnectAttempts: 2,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      })
    );
    const running = provider.start(observer);

    await waitFor(() => observer.health.odds?.status === "connected");
    expect(fixtureRequests).toBe(2);
    expect(delays).toEqual([10]);
    expect(observer.fixtures).toHaveLength(1);
    expect(provider.observedFixtures()).toHaveLength(1);
    expect(observer.connections).toContainEqual(
      expect.objectContaining({ status: "reconnecting" })
    );
    await provider.stop();
    await running;
  });

  it("publishes snapshot timestamps monotonically even when records arrive reversed", async () => {
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path === "/api/odds/snapshot/42") {
        return jsonResponse([officialOdds("newer", 4_000), officialOdds("older", 3_000)]);
      }
      if (path === "/api/scores/snapshot/42") {
        return jsonResponse([officialGoal(2, 4_000), officialGoal(1, 3_000)]);
      }
      if (path.endsWith("/stream")) return hangingSse([]);
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch));
    const running = provider.start(observer);

    await waitFor(() => observer.health.scores?.status === "connected");
    expect(observer.oddsTimestamps).toEqual([
      new Date(3_000).toISOString(),
      new Date(4_000).toISOString()
    ]);
    expect(observer.scoreTimestamps).toEqual([
      new Date(3_000).toISOString(),
      new Date(4_000).toISOString()
    ]);
    await provider.stop();
    await running;
  });

  it("evicts the oldest retained official records at the configured bound", async () => {
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path === "/api/odds/snapshot/42") {
        return jsonResponse([
          officialOdds("oldest", 1_000),
          officialOdds("middle", 2_000),
          officialOdds("newest", 3_000)
        ]);
      }
      if (path === "/api/scores/snapshot/42") return jsonResponse([]);
      if (path.endsWith("/stream")) return hangingSse([]);
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch, { maxRetainedMessages: 2 }));
    const running = provider.start(observer);

    await waitFor(() => observer.health.odds?.status === "connected");
    const retained = provider.receivedOfficialRecords();
    expect(retained).toHaveLength(2);
    expect(
      retained.map((entry) => (entry.feed === "odds" ? entry.record.MessageId : "unexpected-score"))
    ).toEqual(["middle", "newest"]);
    await provider.stop();
    await running;
  });

  it("single-flights concurrent stream JWT renewal and fails closed on 403", async () => {
    let renewalRequests = 0;
    let rejectedStreams = 0;
    let releaseBothRejected: (() => void) | undefined;
    const bothRejected = new Promise<void>((resolve) => {
      releaseBothRejected = resolve;
    });
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      const authorization = headersRecord(init.headers).authorization;
      if (path === "/auth/guest/start") {
        renewalRequests += 1;
        await bothRejected;
        return jsonResponse({ token: "renewed-guest-jwt-value" });
      }
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path.endsWith("/stream")) {
        if (authorization === "Bearer guest-jwt-value") {
          rejectedStreams += 1;
          if (rejectedStreams === 2) releaseBothRejected?.();
          return new Response(null, { status: 401 });
        }
        return hangingSse([]);
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch));
    const running = provider.start(observer);

    await waitFor(() => observer.health.odds?.status === "connected");
    await waitFor(() => observer.health.scores?.status === "connected");
    expect(renewalRequests).toBe(1);
    await provider.stop();
    await running;

    let forbiddenStreamRequests = 0;
    let forbiddenRenewals = 0;
    const forbidden = new LiveTxLineProvider(
      options(
        async (input: string) => {
          const path = new URL(input).pathname;
          if (path === "/auth/guest/start") {
            forbiddenRenewals += 1;
            return jsonResponse({ token: "must-not-be-used" });
          }
          if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
          if (path.includes("/snapshot/")) return jsonResponse([]);
          if (path === "/api/scores/stream") return hangingSse([]);
          if (path === "/api/odds/stream") {
            forbiddenStreamRequests += 1;
            return new Response(null, { status: 403 });
          }
          throw new Error(`Unexpected test path ${path}`);
        },
        { maxReconnectAttempts: 4 }
      )
    );
    await expect(forbidden.start(new RecordingObserver())).rejects.toThrow("HTTP 403");
    expect(forbiddenStreamRequests).toBe(1);
    expect(forbiddenRenewals).toBe(0);
  });

  it("uses only documented historical score and odds bucket fallbacks", async () => {
    const fixtureStart = Date.parse(NOW) - 7 * 24 * 60 * 60 * 1_000;
    const { GameState: _state, ...fixture } = officialFixture();
    void _state;
    const paths: string[] = [];
    const fetch = async (input: string): Promise<Response> => {
      const url = new URL(input);
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/fixtures/snapshot") {
        return jsonResponse([{ ...fixture, Ts: fixtureStart, StartTime: fixtureStart }]);
      }
      if (url.pathname === "/api/odds/snapshot/42") return jsonResponse([]);
      if (url.pathname.startsWith("/api/odds/updates/")) {
        return jsonResponse([officialOdds("historical-odds", fixtureStart)]);
      }
      if (url.pathname === "/api/scores/snapshot/42") return jsonResponse([]);
      if (url.pathname === "/api/scores/historical/42") {
        return jsonResponse([{ ...officialGoal(1, fixtureStart), startTime: fixtureStart }]);
      }
      if (url.pathname.endsWith("/stream")) return hangingSse([]);
      throw new Error(`Unexpected test path ${url.pathname}`);
    };
    const provider = new LiveTxLineProvider(options(fetch));
    const running = provider.start(new RecordingObserver());

    await waitFor(() => provider.receivedOfficialRecords().length === 2);
    expect(paths).toContain(historicalOddsBucketPath(fixtureStart, 42));
    expect(paths).toContain("/api/scores/historical/42");
    expect(paths.some((path) => path.includes("/api/odds/historical"))).toBe(false);
    expect(provider.observedFixtures()[0]?.status).toBe("unknown");
    await provider.stop();
    await running;
  });

  it("resumes with Last-Event-ID and ignores duplicate, out-of-order, and repeated records", async () => {
    let oddsConnections = 0;
    const resumeHeaders: Array<string | undefined> = [];
    const delays: number[] = [];
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path === "/api/scores/stream") return hangingSse([]);
      if (path === "/api/odds/stream") {
        oddsConnections += 1;
        resumeHeaders.push(headersRecord(init.headers)["last-event-id"]);
        if (oddsConnections === 1) {
          const first = officialOdds("same-message", 2_000);
          return finiteSse([
            `id: 2000:1\ndata: ${JSON.stringify(first)}\n\n`,
            `id: 2000:1\ndata: ${JSON.stringify(first)}\n\n`,
            `id: 1999:9\ndata: ${JSON.stringify(officialOdds("older", 1_999))}\n\n`,
            `id: 2000:2\ndata: ${JSON.stringify(first)}\n\n`
          ]);
        }
        return hangingSse([]);
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const provider = new LiveTxLineProvider(
      options(fetch, {
        maxReconnectAttempts: 2,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      })
    );
    const running = provider.start(new RecordingObserver());

    await waitFor(() => oddsConnections === 2);
    expect(resumeHeaders).toEqual([undefined, "2000:2"]);
    expect(delays).toEqual([10]);
    expect(
      provider.receivedOfficialRecords().filter((record) => record.feed === "odds")
    ).toHaveLength(1);
    await provider.stop();
    await running;
  });

  it("isolates score ordering by fixture connection while advancing the SSE cursor", async () => {
    let scoreConnections = 0;
    const resumeHeaders: Array<string | undefined> = [];
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path === "/api/odds/stream") return hangingSse([]);
      if (path === "/api/scores/stream") {
        scoreConnections += 1;
        resumeHeaders.push(headersRecord(init.headers)["last-event-id"]);
        if (scoreConnections === 1) {
          return finiteSse([
            `id: 3000:1\ndata: ${JSON.stringify(officialGoal(2, 3_000, 99))}\n\n`,
            `id: 3000:2\ndata: ${JSON.stringify(officialGoal(1, 3_001, 99))}\n\n`,
            `id: 3000:3\ndata: ${JSON.stringify(officialGoal(1, 3_002, 100))}\n\n`
          ]);
        }
        return hangingSse([]);
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const provider = new LiveTxLineProvider(
      options(fetch, {
        maxReconnectAttempts: 1,
        sleep: async () => undefined
      })
    );
    const running = provider.start(new RecordingObserver());

    await waitFor(() => scoreConnections === 2);
    expect(resumeHeaders).toEqual([undefined, "3000:3"]);
    expect(
      provider.receivedOfficialRecords().filter((record) => record.feed === "scores")
    ).toHaveLength(2);
    expect(provider.receivedMessages()).toHaveLength(2);
    await provider.stop();
    await running;
  });

  it("retains and advances past schema-valid ambiguous score flags without fabricating an event", async () => {
    let scoreConnections = 0;
    const resumeHeaders: Array<string | undefined> = [];
    const base = officialGoal(1, 3_000);
    const ambiguous = {
      ...base,
      dataSoccer: { ...base.dataSoccer, Penalty: true }
    };
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path === "/api/odds/stream") return hangingSse([]);
      if (path === "/api/scores/stream") {
        scoreConnections += 1;
        resumeHeaders.push(headersRecord(init.headers)["last-event-id"]);
        return scoreConnections === 1
          ? finiteSse([`id: 3000:1\ndata: ${JSON.stringify(ambiguous)}\n\n`])
          : hangingSse([]);
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const provider = new LiveTxLineProvider(
      options(fetch, { maxReconnectAttempts: 1, sleep: async () => undefined })
    );
    const running = provider.start(new RecordingObserver());

    await waitFor(() => scoreConnections === 2);
    expect(resumeHeaders).toEqual([undefined, "3000:1"]);
    expect(
      provider.receivedOfficialRecords().filter((entry) => entry.feed === "scores")
    ).toHaveLength(1);
    expect(provider.receivedMessages()).toEqual([]);
    await provider.stop();
    await running;
  });

  it("uses bounded exponential backoff and stops after the configured reconnect attempts", async () => {
    let oddsConnections = 0;
    const delays: number[] = [];
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path === "/api/scores/stream") return hangingSse([]);
      if (path === "/api/odds/stream") {
        oddsConnections += 1;
        return new Response(null, { status: 500 });
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(
      options(fetch, {
        maxReconnectAttempts: 2,
        retryInitialDelayMs: 10,
        retryMaxDelayMs: 20,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      })
    );

    await expect(provider.start(observer)).rejects.toThrow(
      "Authenticated TxLINE request /api/odds/stream failed with HTTP 500"
    );
    expect(oddsConnections).toBe(3);
    expect(delays).toEqual([10, 20]);
    expect(observer.health.odds).toMatchObject({ status: "disconnected", reconnectAttempt: 2 });
  });

  it("reconnects on idle timeout and supports AbortController shutdown", async () => {
    let streamCancellations = 0;
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path.endsWith("/stream")) {
        return hangingSse([], () => {
          streamCancellations += 1;
        });
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(
      options(fetch, { idleTimeoutMs: 15, maxReconnectAttempts: 0 })
    );

    await expect(provider.start(observer)).rejects.toThrow("stream exceeded its idle timeout");
    expect(streamCancellations).toBeGreaterThanOrEqual(1);
    expect(
      Object.values(observer.health).some((health) => health.error?.includes("idle timeout"))
    ).toBe(true);
  });

  it("extends the stream idle deadline after each valid heartbeat", async () => {
    let emittedHeartbeats = 0;
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path.endsWith("/stream")) {
        return periodicHeartbeatSse(10, 4, () => {
          emittedHeartbeats += 1;
        });
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const provider = new LiveTxLineProvider(
      options(fetch, { idleTimeoutMs: 25, maxReconnectAttempts: 0 })
    );
    const startedAt = Date.now();

    await expect(provider.start(new RecordingObserver())).rejects.toThrow(
      "stream exceeded its idle timeout"
    );
    expect(emittedHeartbeats).toBe(8);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("does not let slow-dripped incomplete SSE frames extend the idle deadline", async () => {
    let emittedFragments = 0;
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path.endsWith("/stream")) {
        return periodicFragmentSse(5, 100, () => {
          emittedFragments += 1;
        });
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const provider = new LiveTxLineProvider(
      options(fetch, { idleTimeoutMs: 25, maxReconnectAttempts: 0 })
    );
    const running = provider.start(new RecordingObserver());

    try {
      await expect(valueWithin(running, 250)).rejects.toThrow("stream exceeded its idle timeout");
      expect(emittedFragments).toBeGreaterThan(2);
      expect(emittedFragments).toBeLessThan(100);
    } finally {
      await provider.stop();
    }
  });

  it("fails closed on malformed official payloads and redacts every credential", async () => {
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/api/fixtures/snapshot") {
        throw new Error("Bearer guest-jwt-value api_token=api-token-value");
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch));

    const error = await provider.start(observer).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const serialized = JSON.stringify({ error: String(error), connections: observer.connections });
    expect(serialized).not.toContain("guest-jwt-value");
    expect(serialized).not.toContain("api-token-value");
    expect(serialized).toContain("[REDACTED]");

    const malformedProvider = new LiveTxLineProvider(
      options(async (input: string) => {
        const path = new URL(input).pathname;
        if (path === "/api/fixtures/snapshot") {
          return jsonResponse([{ ...officialFixture(), undocumented: true }]);
        }
        throw new Error(`Unexpected test path ${path}`);
      })
    );
    await expect(malformedProvider.start(new RecordingObserver())).rejects.toThrow();
    expect(malformedProvider.fixtures()).toEqual([]);
  });

  it("redacts a renewed JWT from later transport failures", async () => {
    let fixtureRequests = 0;
    const fetch = async (input: string): Promise<Response> => {
      const path = new URL(input).pathname;
      if (path === "/auth/guest/start") {
        return jsonResponse({ token: "renewed-secret-guest-jwt" });
      }
      if (path === "/api/fixtures/snapshot") {
        fixtureRequests += 1;
        return fixtureRequests === 1
          ? new Response(null, { status: 401 })
          : jsonResponse([officialFixture()]);
      }
      if (path.includes("/snapshot/")) return jsonResponse([]);
      if (path === "/api/scores/stream") return hangingSse([]);
      if (path === "/api/odds/stream") {
        throw new Error("Bearer renewed-secret-guest-jwt api_token=api-token-value");
      }
      throw new Error(`Unexpected test path ${path}`);
    };
    const observer = new RecordingObserver();
    const provider = new LiveTxLineProvider(options(fetch, { maxReconnectAttempts: 0 }));

    const error = await provider.start(observer).catch((caught: unknown) => caught);
    const serialized = JSON.stringify({ error: String(error), connections: observer.connections });
    expect(serialized).not.toContain("renewed-secret-guest-jwt");
    expect(serialized).not.toContain("api-token-value");
    expect(serialized).toContain("[REDACTED]");
  });

  it("cancels an in-flight bootstrap fetch and an in-progress retry delay", async () => {
    let fetchStarted = false;
    let fetchAborted = false;
    const fetchingProvider = new LiveTxLineProvider(
      options(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            fetchStarted = true;
            init.signal?.addEventListener(
              "abort",
              () => {
                fetchAborted = true;
                reject(namedAbortError());
              },
              { once: true }
            );
          })
      )
    );
    const fetchingRun = fetchingProvider.start(new RecordingObserver());
    await waitFor(() => fetchStarted);
    await fetchingProvider.stop();
    await fetchingRun;
    expect(fetchAborted).toBe(true);

    let backoffStarted = false;
    let backoffAborted = false;
    const backoffProvider = new LiveTxLineProvider(
      options(
        async (input) => {
          const path = new URL(input).pathname;
          if (path === "/api/fixtures/snapshot") return jsonResponse([officialFixture()]);
          if (path.includes("/snapshot/")) return jsonResponse([]);
          if (path === "/api/scores/stream") return hangingSse([]);
          if (path === "/api/odds/stream") return new Response(null, { status: 500 });
          throw new Error(`Unexpected test path ${path}`);
        },
        {
          maxReconnectAttempts: 2,
          sleep: async (_milliseconds, signal) =>
            new Promise<void>((_resolve, reject) => {
              backoffStarted = true;
              signal.addEventListener(
                "abort",
                () => {
                  backoffAborted = true;
                  reject(namedAbortError());
                },
                { once: true }
              );
            })
        }
      )
    );
    const backoffRun = backoffProvider.start(new RecordingObserver());
    await waitFor(() => backoffStarted);
    await backoffProvider.stop();
    await backoffRun;
    expect(backoffAborted).toBe(true);
  });

  it("maps only documented fixture state values and validates aligned official odds arrays", () => {
    const provider = new LiveTxLineProvider(true, 2, []);
    expect(provider.readiness()).toEqual({
      ready: false,
      reason: "Official TxLINE transport adapter is not configured."
    });
    expect(
      () =>
        new LiveTxLineProvider(
          options(async () => jsonResponse([]), {
            apiOrigin: "https://user:secret@example.test"
          })
        )
    ).toThrow("credential-free HTTPS origin");
    expect(adaptTxLineFixture({ ...officialFixture(), GameState: 6 }, NOW).fixture.status).toBe(
      "cancelled"
    );
    const { GameState: _state, ...withoutState } = officialFixture();
    void _state;
    expect(adaptTxLineFixture(withoutState, NOW).fixture.status).toBe("unknown");
    expect(() =>
      txLineFixtureSchema.parse({ ...officialFixture(), GameState: 1, gameState: 6 })
    ).toThrow("casing variants must agree");
    expect(() =>
      txLineOddsSchema.parse({
        ...officialOdds("misaligned", 2_000),
        Pct: ["50.000", "50.000"]
      })
    ).toThrow("must align");
    expect(() =>
      txLineScoreSchema.parse({ ...officialGoal(100, 2_000), action: undefined })
    ).toThrow();
    expect(() => txLineScoreSchema.parse({ ...officialGoal(1, 2_000), seq: 0 })).toThrow();
  });
});

const NOW = "2026-07-12T00:00:00.000Z";

class RecordingObserver implements LiveTxLineObserver {
  public connections: Array<{ status: LiveConnectionStatus; error?: string }> = [];
  public authenticated: boolean[] = [];
  public fixtures: LiveFixtureObservation[] = [];
  public oddsTimestamps: string[] = [];
  public scoreTimestamps: string[] = [];
  public health: Partial<Record<"odds" | "scores", LiveStreamHealth>> = {};
  public verifications: VerificationResult[] = [];
  public messages: ProviderMessage[] = [];

  public onConnectionStatus(status: LiveConnectionStatus, error?: string): void {
    this.connections.push({ status, ...(error ? { error } : {}) });
  }

  public onAuthenticated(authenticated: boolean): void {
    this.authenticated.push(authenticated);
  }

  public onFixture(fixture: LiveFixtureObservation): void {
    this.fixtures.push(structuredClone(fixture));
  }

  public onOddsTimestamp(timestamp: string): void {
    this.oddsTimestamps.push(timestamp);
  }

  public onScoreTimestamp(timestamp: string): void {
    this.scoreTimestamps.push(timestamp);
  }

  public onStreamHealth(stream: "odds" | "scores", health: LiveStreamHealth): void {
    this.health[stream] = structuredClone(health);
  }

  public onVerification(result: VerificationResult): void {
    this.verifications.push(structuredClone(result));
  }

  public onProviderMessage(message: ProviderMessage): void {
    this.messages.push(structuredClone(message));
  }
}

function options(
  fetch: (input: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<LiveTxLineProviderOptions> = {}
): LiveTxLineProviderOptions {
  return {
    enabled: true,
    apiOrigin: "https://txline.test",
    guestJwt: "guest-jwt-value",
    apiToken: "api-token-value",
    maxRetainedMessages: 10,
    requestTimeoutMs: 500,
    idleTimeoutMs: 500,
    retryInitialDelayMs: 10,
    retryMaxDelayMs: 40,
    maxReconnectAttempts: 1,
    now: () => new Date(NOW),
    fetch,
    ...overrides
  };
}

function officialFixture() {
  return {
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
    GameState: 1
  } as const;
}

function officialOdds(messageId: string, timestamp: number) {
  return {
    FixtureId: 42,
    MessageId: messageId,
    Ts: timestamp,
    Bookmaker: "Official bookmaker",
    BookmakerId: 7,
    SuperOddsType: "Match Winner",
    InRunning: true,
    PriceNames: ["Home", "Draw", "Away"],
    Prices: [10123, 20234, 30345],
    Pct: ["50.000", "30.000", "20.000"]
  };
}

function officialGoal(sequence: number, timestamp: number, connectionId = 99) {
  const score = (goals: number) => ({
    Goals: goals,
    YellowCards: 0,
    RedCards: 0,
    Corners: 0
  });
  return {
    fixtureId: 42,
    gameState: "in_play",
    startTime: 2_000,
    isTeam: true,
    fixtureGroupId: 20,
    competitionId: 10,
    countryId: 1,
    sportId: 1,
    participant1IsHome: true,
    participant2Id: 202,
    participant1Id: 101,
    action: "score_update",
    id: sequence,
    ts: timestamp,
    connectionId,
    seq: sequence,
    confirmed: true,
    dataSoccer: { Goal: true, Minutes: 12, Participant: 101 },
    scoreSoccer: {
      Participant1: { Total: score(1) },
      Participant2: { Total: score(0) }
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function hangingSse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        onCancel?.();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }
  );
}

function finiteSse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function periodicHeartbeatSse(
  intervalMs: number,
  count: number,
  onHeartbeat: () => void
): Response {
  const frame = new TextEncoder().encode('event: heartbeat\ndata: {"Ts":1000}\n\n');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let emitted = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          controller.enqueue(frame);
          onHeartbeat();
          emitted += 1;
          if (emitted < count) timeout = setTimeout(emit, intervalMs);
        };
        emit();
      },
      cancel() {
        if (timeout) clearTimeout(timeout);
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function periodicFragmentSse(intervalMs: number, count: number, onFragment: () => void): Response {
  const fragment = new TextEncoder().encode("data: incomplete");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let emitted = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          controller.enqueue(fragment);
          onFragment();
          emitted += 1;
          if (emitted < count) timeout = setTimeout(emit, intervalMs);
        };
        emit();
      },
      cancel() {
        if (timeout) clearTimeout(timeout);
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function valueWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Live provider exceeded the bounded test deadline")),
      timeoutMs
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function slowDripJson(onChunk: () => void): Response {
  const bytes = new TextEncoder().encode(" ");
  let cancelled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancelled) return;
        onChunk();
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for live transport test state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function rejectionWithin(promise: Promise<void>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Live provider exceeded its absolute test deadline")),
      timeoutMs
    );
    void promise.then(
      () => {
        clearTimeout(timeout);
        resolve(new Error("Expected the live provider to reject"));
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve(error);
      }
    );
  });
}

function namedAbortError(): Error {
  const error = new Error("test operation aborted");
  error.name = "AbortError";
  return error;
}
