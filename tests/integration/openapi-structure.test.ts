import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

interface SchemaObject {
  $ref?: string;
  title?: string;
  type?: string;
  format?: string;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
}

interface OpenApiOperation {
  responses: Record<string, { content?: { "application/json"?: { schema?: SchemaObject } } }>;
}

interface OpenApiDocument {
  components: { schemas: Record<string, SchemaObject> };
  paths: Record<string, { get?: OpenApiOperation; post?: OpenApiOperation }>;
}

describe("OpenAPI domain schema structure", () => {
  it("publishes typed nested response models instead of required-only shells", async () => {
    const app = await buildServer({
      config: loadConfig({ SENTINEL_MODE: "replay", LOG_LEVEL: "silent" }),
      serveDashboard: false
    });

    try {
      const response = await app.inject("/docs/json");
      expect(response.statusCode).toBe(200);
      const document = JSON.parse(response.body) as OpenApiDocument;

      const signal = byTitle(document, "Signal");
      expect(signal.additionalProperties).toBe(false);
      expect(signal.required).toEqual(
        expect.arrayContaining([
          "movement",
          "ruleBasedConfidenceScore",
          "confidenceComponents",
          "explanation",
          "counterfactual"
        ])
      );
      expect(signal.properties?.ruleBasedConfidenceScore).toMatchObject({
        type: "number",
        minimum: 0,
        maximum: 1
      });
      expect(dereference(document, signal.properties?.movement).title).toBe("MovementMetrics");
      expect(dereference(document, signal.properties?.confidenceComponents?.items).title).toBe(
        "ConfidenceComponent"
      );
      expect(dereference(document, signal.properties?.counterfactual).title).toBe(
        "CounterfactualEvaluation"
      );

      const counterfactual = byTitle(document, "CounterfactualPoint");
      expect(counterfactual.properties?.classification?.enum).toEqual([
        "persisted",
        "reversed",
        "inconclusive"
      ]);
      expect(counterfactual.properties?.observedAt).toMatchObject({
        type: "string",
        format: "date-time"
      });

      const status = byTitle(document, "AgentStatus");
      expect(status.additionalProperties).toBe(false);
      expect(dereference(document, status.properties?.feedHealth).title).toBe("FeedHealthSummary");
      expect(dereference(document, status.properties?.latestOdds).title).toBe(
        "NormalizedOddsSnapshot"
      );

      const fixture = byTitle(document, "Fixture");
      expect(fixture.properties?.status?.enum).toEqual([
        "scheduled",
        "live",
        "finished",
        "cancelled"
      ]);
      expect(dereference(document, fixture.properties?.score).title).toBe("Score");

      const alert = byTitle(document, "OperationalAlert");
      expect(alert.properties?.type?.enum).toContain("terminal_event_rejected");
      expect(alert.properties?.id).toMatchObject({
        type: "string",
        maxLength: 320
      });
      expect(alert.properties?.fixtureId).toMatchObject({
        type: "string",
        maxLength: 128
      });

      const sessionCapacity = byTitle(document, "ReplaySessionCapacityError");
      expect(sessionCapacity).toMatchObject({
        additionalProperties: false,
        required: ["error", "code"]
      });
      expect(sessionCapacity.properties?.error?.enum).toEqual([
        "Replay session capacity reached; try again later"
      ]);
      expect(sessionCapacity.properties?.code?.enum).toEqual(["REPLAY_SESSION_CAPACITY"]);

      for (const [method, path] of sessionBoundOperations) {
        const operation = document.paths[path]?.[method];
        expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
        const capacitySchema = operation?.responses["503"]?.content?.["application/json"]?.schema;
        expect(dereference(document, capacitySchema).title).toBe("ReplaySessionCapacityError");
      }

      const readinessCapacity =
        document.paths["/ready"]?.get?.responses["503"]?.content?.["application/json"]?.schema;
      expect(readinessCapacity?.$ref).toBeUndefined();
      expect(readinessCapacity?.required).toEqual(["status", "ready", "reason"]);

      const position = byTitle(document, "PaperPosition");
      expect(position.properties?.note?.enum).toEqual(["SIMULATION ONLY — NO REAL MONEY"]);
      expect(position.properties?.status?.enum).toEqual(["open", "settled"]);

      for (const title of [
        "Fixture",
        "Signal",
        "OperationalAlert",
        "PaperPosition",
        "Analytics",
        "AuditEvent",
        "AgentStatus"
      ]) {
        expect(Object.keys(byTitle(document, title).properties ?? {}).length).toBeGreaterThan(3);
      }
    } finally {
      await app.close();
    }
  });
});

const sessionBoundOperations = [
  ["get", "/api/agent/status"],
  ["get", "/api/fixtures"],
  ["get", "/api/signals"],
  ["get", "/api/signals/{id}"],
  ["get", "/api/alerts"],
  ["get", "/api/positions"],
  ["get", "/api/analytics"],
  ["get", "/api/audit"],
  ["post", "/api/replay/start"],
  ["post", "/api/replay/pause"],
  ["post", "/api/replay/resume"],
  ["post", "/api/replay/reset"],
  ["post", "/api/replay/advance"]
] as const satisfies ReadonlyArray<["get" | "post", string]>;

function byTitle(document: OpenApiDocument, title: string): SchemaObject {
  const schema = Object.values(document.components.schemas).find(
    (candidate) => candidate.title === title
  );
  if (!schema) throw new Error(`OpenAPI schema ${title} was not found`);
  return schema;
}

function dereference(document: OpenApiDocument, schema: SchemaObject | undefined): SchemaObject {
  const reference = schema?.$ref;
  const key = reference?.split("/").at(-1);
  if (!key) throw new Error("Expected an OpenAPI schema reference");
  const target = document.components.schemas[key];
  if (!target) throw new Error(`OpenAPI schema reference ${reference} was not found`);
  return target;
}
