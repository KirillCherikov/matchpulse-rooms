import type { FastifyInstance } from "fastify";

const entity = (id: string, required: string[]) => ({
  $id: id,
  type: "object",
  required,
  additionalProperties: true
});

export function registerOpenApiSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: "Error",
    type: "object",
    required: ["error"],
    properties: { error: {} },
    additionalProperties: false
  });
  app.addSchema({
    $id: "ReplayControl",
    type: "object",
    default: {},
    properties: { speed: { type: "integer", enum: [1, 2, 5, 10] } },
    additionalProperties: false
  });
  app.addSchema({
    $id: "ReplayState",
    type: "object",
    required: ["status", "speed", "cursor", "totalEvents"],
    properties: {
      status: { type: "string", enum: ["idle", "running", "paused", "finished"] },
      speed: { type: "integer", enum: [1, 2, 5, 10] },
      cursor: { type: "integer", minimum: 0 },
      totalEvents: { type: "integer", minimum: 0 },
      simulatedTime: { type: "string", format: "date-time" }
    },
    additionalProperties: false
  });
  app.addSchema(
    entity("Fixture", ["id", "competition", "homeTeam", "awayTeam", "status", "score", "minute"])
  );
  app.addSchema(
    entity("Signal", [
      "id",
      "fixtureId",
      "market",
      "selection",
      "ruleBasedConfidenceScore",
      "paperDecision",
      "strategyConfigurationVersion"
    ])
  );
  app.addSchema(
    entity("OperationalAlert", [
      "id",
      "type",
      "severity",
      "fixtureId",
      "feed",
      "timestamp",
      "message"
    ])
  );
  app.addSchema(
    entity("PaperPosition", [
      "id",
      "signalId",
      "fixtureId",
      "selection",
      "status",
      "stake",
      "entryOdds",
      "note"
    ])
  );
  app.addSchema(
    entity("Analytics", [
      "virtualBankroll",
      "virtualPnl",
      "openExposure",
      "settledPositions",
      "winRate",
      "maximumDrawdown",
      "maximumDrawdownPercent",
      "signalPrecision"
    ])
  );
  app.addSchema(
    entity("AuditEvent", ["id", "sequence", "runId", "correlationId", "type", "timestamp", "data"])
  );
  app.addSchema(
    entity("AgentStatus", ["mode", "ready", "feedHealth", "auditEvents", "disclaimer"])
  );
  app.addSchema({
    $id: "ReplayResponse",
    type: "object",
    required: ["replay"],
    properties: { replay: { $ref: "ReplayState#" } },
    additionalProperties: true
  });
}

export const errorResponses = {
  400: { $ref: "Error#" },
  403: { $ref: "Error#" },
  409: { $ref: "Error#" }
} as const;
