import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
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
  });
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
