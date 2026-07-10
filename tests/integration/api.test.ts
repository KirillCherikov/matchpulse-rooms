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
  it("exposes health, replay controls, decisions, and audit endpoints", async () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });
    const app = await buildServer({ agent, serveDashboard: false });
    servers.push(app);
    expect((await app.inject("/health")).statusCode).toBe(200);
    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject({ method: "POST", url: "/api/replay/advance" })).statusCode).toBe(
        200
      );
    }
    const signals = await app.inject("/api/signals");
    expect(JSON.parse(signals.body).signals).toHaveLength(1);
    expect((await app.inject("/api/audit")).statusCode).toBe(200);
    expect((await app.inject("/docs/json")).statusCode).toBe(200);
  });
});
