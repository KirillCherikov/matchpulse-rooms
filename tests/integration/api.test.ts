import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";
import type { Fixture, ProviderMessage } from "../../src/domain/models.js";
import { ReplayTxLineProvider } from "../../src/providers/replay.js";
import { buildServer } from "../../src/server.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("REST API", () => {
  it("exposes every judge endpoint with replay controls and OpenAPI contracts", async () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" }),
      mode: "replay"
    });
    const app = await buildServer({ agent, serveDashboard: false });
    servers.push(app);
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/ready")).statusCode).toBe(200);
    expect((await app.inject("/api/agent/status")).statusCode).toBe(200);
    expect((await app.inject("/api/fixtures")).statusCode).toBe(200);
    expect((await app.inject("/api/alerts")).statusCode).toBe(200);
    expect((await app.inject("/api/positions")).statusCode).toBe(200);
    expect((await app.inject("/api/analytics")).statusCode).toBe(200);
    expect((await app.inject("/api/signals/missing")).statusCode).toBe(404);

    const started = await app.inject({ method: "POST", url: "/api/replay/start" });
    expect(started.statusCode).toBe(200);
    expect(JSON.parse(started.body).replay.status).toBe("running");
    expect((await app.inject({ method: "POST", url: "/api/replay/pause" })).statusCode).toBe(200);
    const resumed = await app.inject({
      method: "POST",
      url: "/api/replay/resume",
      payload: { speed: 2 }
    });
    expect(JSON.parse(resumed.body).replay.speed).toBe(2);

    while (agent.status().replay?.status !== "finished") {
      expect((await app.inject({ method: "POST", url: "/api/replay/advance" })).statusCode).toBe(
        200
      );
    }
    const signals = await app.inject("/api/signals");
    const signal = JSON.parse(signals.body).signals[0] as { id: string };
    expect(signal.id).toMatch(/^replay-run-/);
    expect((await app.inject(`/api/signals/${signal.id}`)).statusCode).toBe(200);
    expect((await app.inject("/api/audit")).statusCode).toBe(200);
    expect((await app.inject("/api/audit?limit=not-a-number")).statusCode).toBe(400);
    expect((await app.inject("/docs/json")).statusCode).toBe(200);

    const reset = await app.inject({ method: "POST", url: "/api/replay/reset" });
    expect(JSON.parse(reset.body).replay.cursor).toBe(0);
    expect(agent.allSignals()).toHaveLength(0);
  });

  it("rejects invalid and cross-origin replay mutations", async () => {
    const app = await buildServer({
      config: loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" }),
      serveDashboard: false
    });
    servers.push(app);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/replay/start",
          payload: { speed: 3 }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/replay/reset",
          headers: { origin: "https://attacker.invalid", host: "sentinel.example" }
        })
      ).statusCode
    ).toBe(403);
  });

  it("isolates replay state between browser sessions", async () => {
    const app = await buildServer({
      config: loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" }),
      serveDashboard: false
    });
    servers.push(app);

    const firstStatus = await app.inject("/api/agent/status");
    const secondStatus = await app.inject("/api/agent/status");
    const firstCookie = firstHeader(firstStatus.headers["set-cookie"])?.split(";", 1)[0];
    const secondCookie = firstHeader(secondStatus.headers["set-cookie"])?.split(";", 1)[0];
    expect(firstCookie).toMatch(/^txline_sentinel_session=/);
    expect(secondCookie).toMatch(/^txline_sentinel_session=/);
    expect(secondCookie).not.toBe(firstCookie);

    await app.inject({
      method: "POST",
      url: "/api/replay/advance",
      headers: { cookie: firstCookie ?? "" }
    });
    const firstAfter = await app.inject({
      method: "GET",
      url: "/api/agent/status",
      headers: { cookie: firstCookie ?? "" }
    });
    const secondAfter = await app.inject({
      method: "GET",
      url: "/api/agent/status",
      headers: { cookie: secondCookie ?? "" }
    });
    expect(JSON.parse(firstAfter.body).replay.cursor).toBe(1);
    expect(JSON.parse(secondAfter.body).replay.cursor).toBe(0);
    expect(firstHeader(firstAfter.headers["set-cookie"])).toContain(firstCookie);
    expect(firstHeader(firstAfter.headers["set-cookie"])).toContain("Max-Age=1800");
  });

  it("keeps readiness session-free and refuses new sessions without evicting active state", async () => {
    const app = await buildServer({
      config: loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" }),
      serveDashboard: false
    });
    servers.push(app);

    const victimStatus = await app.inject("/api/agent/status");
    const victimCookie = firstHeader(victimStatus.headers["set-cookie"])?.split(";", 1)[0];
    expect(victimCookie).toBeDefined();
    await app.inject({
      method: "POST",
      url: "/api/replay/advance",
      headers: { cookie: victimCookie ?? "" }
    });

    for (let index = 0; index < 40; index += 1) {
      const readiness = await app.inject("/ready");
      expect(readiness.statusCode).toBe(200);
      expect(readiness.headers["set-cookie"]).toBeUndefined();
    }

    for (let index = 0; index < 31; index += 1) {
      expect((await app.inject("/api/agent/status")).statusCode).toBe(200);
    }
    for (const request of sessionBoundRequests) {
      const rejected = await app.inject(request);
      expect(rejected.statusCode, `${request.method} ${request.url}`).toBe(503);
      expect(JSON.parse(rejected.body)).toEqual({
        error: "Replay session capacity reached; try again later",
        code: "REPLAY_SESSION_CAPACITY"
      });
      expect(rejected.headers["set-cookie"]).toBeUndefined();
    }

    const readinessAtCapacity = await app.inject("/ready");
    expect(readinessAtCapacity.statusCode).toBe(200);
    expect(readinessAtCapacity.headers["set-cookie"]).toBeUndefined();

    const victimAfter = await app.inject({
      method: "GET",
      url: "/api/agent/status",
      headers: { cookie: victimCookie ?? "" }
    });
    expect(victimAfter.statusCode).toBe(200);
    expect(JSON.parse(victimAfter.body).replay.cursor).toBe(1);
  });

  it("serializes generated divergence IDs built from maximum-length provider IDs", async () => {
    const fixtureId = "f".repeat(128);
    const eventId = "e".repeat(128);
    const fixture: Fixture = {
      id: fixtureId,
      competition: "Identifier boundary fixture",
      homeTeam: "Home FC",
      awayTeam: "Away FC",
      status: "live",
      score: { home: 0, away: 0 },
      minute: 1
    };
    const messages: ProviderMessage[] = [
      {
        kind: "score",
        id: eventId,
        fixtureId,
        sequence: 1,
        sourceTimestamp: "2026-01-01T12:00:00.000Z",
        receivedTimestamp: "2026-01-01T12:00:00.000Z",
        type: "goal",
        minute: 1,
        team: "home",
        score: { home: 1, away: 0 },
        confirmed: true,
        rawReference: `test://score/${eventId}`
      },
      {
        kind: "odds",
        id: "odds-after-correlation-window",
        fixtureId,
        market: "match_winner",
        sequence: 1,
        sourceTimestamp: "2026-01-01T12:00:46.000Z",
        receivedTimestamp: "2026-01-01T12:00:46.000Z",
        selections: [
          { selection: "home", decimalOdds: 2.2 },
          { selection: "draw", decimalOdds: 3.4 },
          { selection: "away", decimalOdds: 3.6 }
        ],
        rawReference: "test://odds/after-correlation-window"
      }
    ];
    const config = loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" });
    const agent = new SentinelAgent(config, new ReplayTxLineProvider([fixture], messages));
    const app = await buildServer({ agent, serveDashboard: false });
    servers.push(app);

    for (let index = 0; index < messages.length; index += 1) {
      expect((await app.inject({ method: "POST", url: "/api/replay/advance" })).statusCode).toBe(
        200
      );
    }

    const response = await app.inject("/api/alerts");
    expect(response.statusCode).toBe(200);
    const alerts = JSON.parse(response.body).alerts as Array<{ id: string; type: string }>;
    const divergence = alerts.find((alert) => alert.type === "odds_score_divergence");
    expect(divergence?.id).toBe(`replay-run-0001:alert-divergence-${fixtureId}-${eventId}`);
    expect(divergence?.id).toHaveLength(290);
  });

  it("rejects automatic replay before a near-capacity audit can crash its scheduler", async () => {
    const config = loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" });
    const agent = SentinelAgent.create(config, { auditEventLimit: 70 });
    for (let index = 0; index < 3; index += 1) agent.resetReplay();
    const app = await buildServer({ agent, serveDashboard: false });
    servers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/replay/start",
      payload: { speed: 10 }
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toContain("Audit capacity is too low");
    expect(agent.status().replay?.status).toBe("idle");
  });

  it("pauses and audits an unexpected scheduler failure without an unhandled rejection", async () => {
    const config = loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" });
    const agent = SentinelAgent.create(config, { auditEventLimit: 100 });
    vi.spyOn(agent, "advanceReplay").mockImplementation(() => {
      throw new Error("synthetic scheduler failure");
    });
    const app = await buildServer({ agent, serveDashboard: false });
    servers.push(app);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/replay/start",
          payload: { speed: 10 }
        })
      ).statusCode
    ).toBe(200);
    await vi.waitFor(() => expect(agent.status().replay?.status).toBe("paused"));
    expect(agent.audit().at(-1)).toMatchObject({
      type: "error",
      data: {
        reason: "replay_scheduler_failure",
        message: "synthetic scheduler failure"
      }
    });
  });

  it("never enables operator Telegram delivery for anonymous replay sessions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildServer({
      config: loadConfig({
        SENTINEL_MODE: "replay",
        LOG_LEVEL: "silent",
        TELEGRAM_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_ALERT_CHAT_ID: "1"
      }),
      serveDashboard: false
    });
    servers.push(app);

    const status = await app.inject("/api/agent/status");
    const cookie = firstHeader(status.headers["set-cookie"])?.split(";", 1)[0];
    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/replay/advance",
            headers: { cookie: cookie ?? "" }
          })
        ).statusCode
      ).toBe(200);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const sessionBoundRequests: Array<{ method: "GET" | "POST"; url: string }> = [
  { method: "GET", url: "/api/agent/status" },
  { method: "GET", url: "/api/fixtures" },
  { method: "GET", url: "/api/signals" },
  { method: "GET", url: "/api/signals/missing" },
  { method: "GET", url: "/api/alerts" },
  { method: "GET", url: "/api/positions" },
  { method: "GET", url: "/api/analytics" },
  { method: "GET", url: "/api/audit" },
  { method: "POST", url: "/api/replay/start" },
  { method: "POST", url: "/api/replay/pause" },
  { method: "POST", url: "/api/replay/resume" },
  { method: "POST", url: "/api/replay/reset" },
  { method: "POST", url: "/api/replay/advance" }
];
