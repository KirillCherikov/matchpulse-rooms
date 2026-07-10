import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import dotenv from "dotenv";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SentinelAgent } from "./application/sentinel-agent.js";
import { loadConfig, type SentinelConfig } from "./config.js";
import { replayControlSchema } from "./domain/schemas.js";

interface ServerOptions {
  config?: SentinelConfig;
  agent?: SentinelAgent;
  serveDashboard?: boolean;
}

class ReplayScheduler {
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly agent: SentinelAgent) {}

  public start(): void {
    this.stop();
    void this.tick();
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const replay = this.agent.status().replay;
    if (!replay || replay.status !== "running") {
      return;
    }
    this.agent.advanceReplay();
    const next = this.agent.status().replay;
    if (!next || next.status !== "running") {
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.tick();
      },
      Math.max(100, Math.round(1_000 / next.speed))
    );
  }
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const agent = options.agent ?? SentinelAgent.create(config);
  const scheduler = new ReplayScheduler(agent);
  const app = Fastify({ logger: { level: config.logLevel } });

  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "TxLINE Sentinel API",
        description:
          "Replay-first explainable sports market intelligence. Simulation only; no real-money execution.",
        version: "0.1.0"
      }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get(
    "/health",
    {
      schema: { tags: ["Operations"], summary: "Liveness check" }
    },
    async () => ({ status: "ok", service: "txline-sentinel" })
  );

  app.get(
    "/ready",
    {
      schema: { tags: ["Operations"], summary: "Readiness check" }
    },
    async (request, reply) => {
      const readiness = agent.readiness();
      if (!readiness.ready) {
        return reply.code(503).send({ status: "not_ready", ...readiness });
      }
      return { status: "ready", ...readiness };
    }
  );

  app.get(
    "/api/agent/status",
    {
      schema: {
        tags: ["Agent"],
        summary: "Get mode, replay state, latest decisions, and feed health"
      }
    },
    async () => agent.status()
  );

  app.get(
    "/api/fixtures",
    {
      schema: { tags: ["Market data"], summary: "List normalized fixtures" }
    },
    async () => ({ fixtures: agent.fixtures() })
  );

  app.get(
    "/api/signals",
    {
      schema: { tags: ["Signals"], summary: "List explainable signal decisions" }
    },
    async () => ({ signals: agent.allSignals() })
  );

  app.get<{ Params: { id: string } }>(
    "/api/signals/:id",
    {
      schema: { tags: ["Signals"], summary: "Get an explainable signal by ID" }
    },
    async (request, reply) => {
      const signal = agent.signal(request.params.id);
      if (!signal) {
        return reply.code(404).send({ error: "Signal not found" });
      }
      return signal;
    }
  );

  app.get(
    "/api/alerts",
    {
      schema: { tags: ["Operations"], summary: "List separate operational data-quality alerts" }
    },
    async () => ({ alerts: agent.allAlerts() })
  );

  app.get(
    "/api/positions",
    {
      schema: { tags: ["Simulation"], summary: "List paper positions only" }
    },
    async () => ({ disclaimer: "SIMULATION ONLY — NO REAL MONEY", positions: agent.positions() })
  );

  app.get(
    "/api/analytics",
    {
      schema: { tags: ["Simulation"], summary: "Get virtual P&L, drawdown, and quality analytics" }
    },
    async () => ({ disclaimer: "SIMULATION ONLY — NO REAL MONEY", analytics: agent.analytics() })
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/audit",
    {
      schema: { tags: ["Audit"], summary: "Read append-only, sanitized audit events" }
    },
    async (request, reply) => {
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) {
        return reply.code(400).send({ error: "limit must be an integer between 1 and 10000" });
      }
      return { events: agent.audit(limit) };
    }
  );

  app.post(
    "/api/replay/start",
    {
      schema: { tags: ["Replay"], summary: "Start deterministic replay at 1x, 2x, 5x, or 10x" }
    },
    async (request, reply) => {
      const parsed = replayControlSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const replay = agent.startReplay(parsed.data.speed);
        scheduler.start();
        return { replay };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  app.post(
    "/api/replay/pause",
    {
      schema: { tags: ["Replay"], summary: "Pause deterministic replay" }
    },
    async (_request, reply) => {
      try {
        const replay = agent.pauseReplay();
        scheduler.stop();
        return { replay };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  app.post(
    "/api/replay/resume",
    {
      schema: { tags: ["Replay"], summary: "Resume deterministic replay" }
    },
    async (request, reply) => {
      const parsed = replayControlSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const replay = agent.resumeReplay(parsed.data.speed);
        scheduler.start();
        return { replay };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  app.post(
    "/api/replay/reset",
    {
      schema: { tags: ["Replay"], summary: "Reset replay state and dynamic simulation state" }
    },
    async (_request, reply) => {
      try {
        scheduler.stop();
        return { replay: agent.resetReplay() };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  app.post(
    "/api/replay/advance",
    {
      schema: { tags: ["Replay"], summary: "Process exactly one deterministic replay input" }
    },
    async (_request, reply) => {
      try {
        scheduler.stop();
        const processed = agent.advanceReplay();
        return { processed, replay: agent.status().replay };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  if (options.serveDashboard !== false) {
    const dashboardRoot = resolve(process.cwd(), "web", "dist");
    if (existsSync(dashboardRoot)) {
      await app.register(fastifyStatic, { root: dashboardRoot, wildcard: false });
      app.get("/signals/:id", async (_request, reply) => reply.sendFile("index.html"));
    }
  }

  app.addHook("onClose", async () => {
    scheduler.stop();
  });
  return app;
}

export async function startServer(): Promise<void> {
  dotenv.config({ path: ".env.local", quiet: true });
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const app = await buildServer({ config });
  await app.listen({ port: config.port, host: config.host });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown replay error";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
