import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import dotenv from "dotenv";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SentinelAgent } from "./application/sentinel-agent.js";
import { errorResponses, registerOpenApiSchemas } from "./api/openapi.js";
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
    const replay = this.agent.status().replay;
    if (!replay || replay.status !== "running") return;
    this.timer = setTimeout(
      () => {
        void this.tick();
      },
      Math.max(100, Math.round(1_000 / replay.speed))
    );
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

interface AgentSession {
  id: string;
  agent: SentinelAgent;
  scheduler: ReplayScheduler;
  lastAccessMs: number;
}

const SESSION_COOKIE = "txline_sentinel_session";
const MAX_REPLAY_SESSIONS = 32;
const SESSION_TTL_MS = 30 * 60 * 1_000;

class AgentSessionRegistry {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly singleton: AgentSession | undefined;

  public constructor(
    private readonly config: SentinelConfig,
    fixedAgent?: SentinelAgent
  ) {
    if (fixedAgent || config.mode === "live") {
      const agent = fixedAgent ?? SentinelAgent.create(config);
      this.singleton = this.createSession("singleton", agent);
    }
  }

  public resolve(request: FastifyRequest, reply: FastifyReply): AgentSession {
    if (this.singleton) return this.singleton;
    const now = Date.now();
    this.evictExpired(now);
    const requestedId = sessionIdFromCookie(request.headers.cookie);
    let session = requestedId ? this.sessions.get(requestedId) : undefined;
    if (!session) {
      this.evictOldestIfFull();
      const id = randomUUID();
      session = this.createSession(id, SentinelAgent.create(this.config));
      this.sessions.set(id, session);
      reply.header(
        "set-cookie",
        `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}${this.config.secureSessionCookie ? "; Secure" : ""}`
      );
    }
    session.lastAccessMs = now;
    return session;
  }

  public close(): void {
    this.singleton?.scheduler.stop();
    for (const session of this.sessions.values()) session.scheduler.stop();
    this.sessions.clear();
  }

  private createSession(id: string, agent: SentinelAgent): AgentSession {
    return { id, agent, scheduler: new ReplayScheduler(agent), lastAccessMs: Date.now() };
  }

  private evictExpired(now: number): void {
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessMs <= SESSION_TTL_MS) continue;
      session.scheduler.stop();
      this.sessions.delete(id);
    }
  }

  private evictOldestIfFull(): void {
    if (this.sessions.size < MAX_REPLAY_SESSIONS) return;
    const oldest = [...this.sessions.values()].sort(
      (left, right) => left.lastAccessMs - right.lastAccessMs
    )[0];
    if (!oldest) return;
    oldest.scheduler.stop();
    this.sessions.delete(oldest.id);
  }
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? options.agent?.config ?? loadConfig();
  const registry = new AgentSessionRegistry(config, options.agent);
  const app = Fastify({ logger: { level: config.logLevel } });

  await app.register(cors, { origin: config.corsOrigin ?? false });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!request.url.startsWith("/docs")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      );
    }
    if (request.url.startsWith("/api/") || request.url === "/ready") {
      reply.header("cache-control", "no-store");
    }
    if (config.secureSessionCookie) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/api/replay/")) return;
    const origin = request.headers.origin;
    if (!origin) return;
    if (!isPermittedOrigin(origin, config.corsOrigin, request.headers.host)) {
      return reply.code(403).send({ error: "Cross-origin replay controls are not permitted" });
    }
  });
  registerOpenApiSchemas(app);
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
      schema: {
        tags: ["Operations"],
        summary: "Liveness check",
        response: {
          200: {
            type: "object",
            required: ["status", "service"],
            properties: { status: { const: "ok" }, service: { const: "txline-sentinel" } }
          }
        }
      }
    },
    async () => ({ status: "ok", service: "txline-sentinel" })
  );

  app.get(
    "/ready",
    {
      schema: {
        tags: ["Operations"],
        summary: "Readiness check",
        response: {
          200: { type: "object", required: ["status", "ready"], additionalProperties: true },
          503: {
            type: "object",
            required: ["status", "ready", "reason"],
            additionalProperties: true
          }
        }
      }
    },
    async (request, reply) => {
      const { agent } = registry.resolve(request, reply);
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
        summary: "Get mode, replay state, latest decisions, and feed health",
        response: { 200: { $ref: "AgentStatus#" } }
      }
    },
    async (request, reply) => registry.resolve(request, reply).agent.status()
  );

  app.get(
    "/api/fixtures",
    {
      schema: {
        tags: ["Market data"],
        summary: "List normalized fixtures",
        response: {
          200: {
            type: "object",
            required: ["fixtures"],
            properties: { fixtures: { type: "array", items: { $ref: "Fixture#" } } }
          }
        }
      }
    },
    async (request, reply) => ({
      fixtures: registry.resolve(request, reply).agent.fixtures()
    })
  );

  app.get(
    "/api/signals",
    {
      schema: {
        tags: ["Signals"],
        summary: "List explainable signal decisions",
        response: {
          200: {
            type: "object",
            required: ["signals"],
            properties: { signals: { type: "array", items: { $ref: "Signal#" } } }
          }
        }
      }
    },
    async (request, reply) => ({
      signals: registry.resolve(request, reply).agent.allSignals()
    })
  );

  app.get<{ Params: { id: string } }>(
    "/api/signals/:id",
    {
      schema: {
        tags: ["Signals"],
        summary: "Get an explainable signal by ID",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } }
        },
        response: { 200: { $ref: "Signal#" }, 404: { $ref: "Error#" } }
      }
    },
    async (request, reply) => {
      const { agent } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Operations"],
        summary: "List separate operational data-quality alerts",
        response: {
          200: {
            type: "object",
            required: ["alerts"],
            properties: { alerts: { type: "array", items: { $ref: "OperationalAlert#" } } }
          }
        }
      }
    },
    async (request, reply) => ({
      alerts: registry.resolve(request, reply).agent.allAlerts()
    })
  );

  app.get(
    "/api/positions",
    {
      schema: {
        tags: ["Simulation"],
        summary: "List paper positions only",
        response: {
          200: {
            type: "object",
            required: ["disclaimer", "positions"],
            properties: {
              disclaimer: { const: "SIMULATION ONLY — NO REAL MONEY" },
              positions: { type: "array", items: { $ref: "PaperPosition#" } }
            }
          }
        }
      }
    },
    async (request, reply) => ({
      disclaimer: "SIMULATION ONLY — NO REAL MONEY",
      positions: registry.resolve(request, reply).agent.positions()
    })
  );

  app.get(
    "/api/analytics",
    {
      schema: {
        tags: ["Simulation"],
        summary: "Get virtual P&L, drawdown, and quality analytics",
        response: {
          200: {
            type: "object",
            required: ["disclaimer", "analytics"],
            properties: {
              disclaimer: { const: "SIMULATION ONLY — NO REAL MONEY" },
              analytics: { $ref: "Analytics#" }
            }
          }
        }
      }
    },
    async (request, reply) => ({
      disclaimer: "SIMULATION ONLY — NO REAL MONEY",
      analytics: registry.resolve(request, reply).agent.analytics()
    })
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/audit",
    {
      schema: {
        tags: ["Audit"],
        summary: "Read append-only, sanitized audit events",
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 10000 } },
          additionalProperties: false
        },
        response: {
          200: {
            type: "object",
            required: ["events"],
            properties: { events: { type: "array", items: { $ref: "AuditEvent#" } } }
          },
          400: { $ref: "Error#" }
        }
      }
    },
    async (request, reply) => {
      const { agent } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Replay"],
        summary: "Start deterministic replay at 1x, 2x, 5x, or 10x",
        body: { $ref: "ReplayControl#" },
        response: { 200: { $ref: "ReplayResponse#" }, ...errorResponses }
      },
      preValidation: async (request) => {
        if (request.body === undefined) request.body = {};
      }
    },
    async (request, reply) => {
      const { agent, scheduler } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Replay"],
        summary: "Pause deterministic replay",
        response: { 200: { $ref: "ReplayResponse#" }, 409: { $ref: "Error#" } }
      }
    },
    async (request, reply) => {
      const { agent, scheduler } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Replay"],
        summary: "Resume deterministic replay",
        body: { $ref: "ReplayControl#" },
        response: { 200: { $ref: "ReplayResponse#" }, ...errorResponses }
      },
      preValidation: async (request) => {
        if (request.body === undefined) request.body = {};
      }
    },
    async (request, reply) => {
      const { agent, scheduler } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Replay"],
        summary: "Reset replay state and dynamic simulation state",
        response: { 200: { $ref: "ReplayResponse#" }, 409: { $ref: "Error#" } }
      }
    },
    async (request, reply) => {
      const { agent, scheduler } = registry.resolve(request, reply);
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
      schema: {
        tags: ["Replay"],
        summary: "Process exactly one deterministic replay input",
        response: {
          200: { type: "object", required: ["replay"], additionalProperties: true },
          409: { $ref: "Error#" }
        }
      }
    },
    async (request, reply) => {
      const { agent, scheduler } = registry.resolve(request, reply);
      try {
        scheduler.stop();
        const processed = agent.advanceReplay(true);
        return { processed, replay: agent.status().replay };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    }
  );

  if (options.serveDashboard !== false) {
    const dashboardRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "web", "dist");
    if (existsSync(dashboardRoot)) {
      await app.register(fastifyStatic, { root: dashboardRoot, wildcard: false });
      app.get("/signals/:id", async (_request, reply) => reply.sendFile("index.html"));
    }
  }

  app.addHook("onClose", async () => {
    registry.close();
  });
  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  dotenv.config({ path: ".env.local", quiet: true });
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const app = await buildServer({ config });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };
  const onSigterm = (): void => void shutdown();
  const onSigint = (): void => void shutdown();
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  app.addHook("onClose", async () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  });
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    throw error;
  }
  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown replay error";
}

function isPermittedOrigin(
  origin: string,
  configuredOrigin: string | undefined,
  host: string | undefined
): boolean {
  if (configuredOrigin) return origin === configuredOrigin;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === host;
  } catch {
    return false;
  }
}

function sessionIdFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
