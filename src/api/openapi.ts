import type { FastifyInstance } from "fastify";
import { MAX_DECIMAL_ODDS, MAX_EXTERNAL_IDENTIFIER_LENGTH } from "../domain/constraints.js";

type JsonSchema = Record<string, unknown>;

export const REPLAY_SESSION_CAPACITY_CODE = "REPLAY_SESSION_CAPACITY";
export const REPLAY_SESSION_CAPACITY_MESSAGE = "Replay session capacity reached; try again later";

const externalIdentifier = {
  type: "string",
  minLength: 1,
  maxLength: MAX_EXTERNAL_IDENTIFIER_LENGTH
};
// Generated alert IDs can scope two legal 128-character provider IDs with the replay run ID.
const generatedIdentifier = { type: "string", minLength: 1, maxLength: 320 };
const timestamp = { type: "string", format: "date-time" };
const finiteNumber = { type: "number" };
const nonnegativeInteger = { type: "integer", minimum: 0 };
const probability = { type: "number", minimum: 0, maximum: 1 };
const decimalOdds = {
  type: "number",
  exclusiveMinimum: 1,
  maximum: MAX_DECIMAL_ODDS
};
const selection = { type: "string", enum: ["home", "draw", "away"] };

function ref(id: string): JsonSchema {
  return { $ref: `${id}#` };
}

function objectSchema(
  id: string,
  required: string[],
  properties: Record<string, JsonSchema>,
  additionalProperties: boolean | JsonSchema = false
): JsonSchema {
  return { $id: id, type: "object", required, properties, additionalProperties };
}

function register(app: FastifyInstance, schema: JsonSchema): void {
  app.addSchema(schema);
}

export function registerOpenApiSchemas(app: FastifyInstance): void {
  register(
    app,
    objectSchema("Error", ["error"], {
      error: {
        oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }]
      }
    })
  );
  register(
    app,
    objectSchema("ReplaySessionCapacityError", ["error", "code"], {
      error: { type: "string", const: REPLAY_SESSION_CAPACITY_MESSAGE },
      code: { type: "string", const: REPLAY_SESSION_CAPACITY_CODE }
    })
  );
  register(
    app,
    objectSchema("ReplayControl", [], {
      speed: { type: "integer", enum: [1, 2, 5, 10] }
    })
  );
  register(
    app,
    objectSchema("ReplayState", ["status", "speed", "cursor", "totalEvents"], {
      status: { type: "string", enum: ["idle", "running", "paused", "finished"] },
      speed: { type: "integer", enum: [1, 2, 5, 10] },
      cursor: nonnegativeInteger,
      totalEvents: nonnegativeInteger,
      simulatedTime: timestamp
    })
  );
  register(
    app,
    objectSchema("Score", ["home", "away"], {
      home: nonnegativeInteger,
      away: nonnegativeInteger
    })
  );
  register(
    app,
    objectSchema(
      "Fixture",
      ["id", "competition", "homeTeam", "awayTeam", "status", "score", "minute"],
      {
        id: externalIdentifier,
        competition: { type: "string", minLength: 1 },
        homeTeam: { type: "string", minLength: 1 },
        awayTeam: { type: "string", minLength: 1 },
        status: {
          type: "string",
          enum: ["unknown", "scheduled", "live", "finished", "cancelled"]
        },
        score: ref("Score"),
        minute: { type: "integer", minimum: 0, maximum: 130 },
        dataLabel: { type: "string", minLength: 1 }
      }
    )
  );
  register(
    app,
    objectSchema(
      "LiveFixtureObservation",
      [
        "id",
        "competition",
        "homeTeam",
        "awayTeam",
        "status",
        "scheduledStartTimestamp",
        "sourceTimestamp",
        "receivedTimestamp",
        "rawReference",
        "dataLabel"
      ],
      {
        id: externalIdentifier,
        competition: { type: "string", minLength: 1 },
        homeTeam: { type: "string", minLength: 1 },
        awayTeam: { type: "string", minLength: 1 },
        status: {
          type: "string",
          enum: ["unknown", "scheduled", "live", "finished", "cancelled"]
        },
        scheduledStartTimestamp: timestamp,
        sourceTimestamp: timestamp,
        receivedTimestamp: timestamp,
        rawReference: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          pattern: "^txline://fixtures/"
        },
        dataLabel: { type: "string", const: "Live TxLINE devnet data" }
      }
    )
  );
  register(
    app,
    objectSchema(
      "NormalizedOddsSelection",
      ["selection", "decimalOdds", "impliedProbability", "normalizedProbability"],
      {
        selection,
        decimalOdds,
        impliedProbability: probability,
        normalizedProbability: probability
      }
    )
  );
  register(
    app,
    objectSchema(
      "NormalizedOddsSnapshot",
      [
        "kind",
        "id",
        "fixtureId",
        "market",
        "sequence",
        "sourceTimestamp",
        "receivedTimestamp",
        "selections",
        "rawReference",
        "bookPercentage",
        "overround"
      ],
      {
        kind: { type: "string", const: "odds" },
        id: externalIdentifier,
        fixtureId: externalIdentifier,
        market: { type: "string", const: "match_winner" },
        sequence: nonnegativeInteger,
        sourceTimestamp: timestamp,
        receivedTimestamp: timestamp,
        selections: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: ref("NormalizedOddsSelection")
        },
        rawReference: { type: "string", minLength: 1, maxLength: 256 },
        bookPercentage: { type: "number", exclusiveMinimum: 0 },
        overround: finiteNumber
      }
    )
  );
  register(
    app,
    objectSchema(
      "MatchEvent",
      [
        "kind",
        "id",
        "fixtureId",
        "sequence",
        "sourceTimestamp",
        "receivedTimestamp",
        "type",
        "minute",
        "confirmed",
        "rawReference"
      ],
      {
        kind: { type: "string", const: "score" },
        id: externalIdentifier,
        fixtureId: externalIdentifier,
        sequence: nonnegativeInteger,
        sourceTimestamp: timestamp,
        receivedTimestamp: timestamp,
        type: {
          type: "string",
          enum: [
            "kickoff",
            "goal",
            "red_card",
            "penalty",
            "var",
            "half_time",
            "full_time",
            "extra_time",
            "shootout",
            "postponed",
            "cancelled"
          ]
        },
        minute: { type: "integer", minimum: 0, maximum: 130 },
        team: { type: "string", enum: ["home", "away"] },
        score: ref("Score"),
        confirmed: { type: "boolean" },
        rawReference: { type: "string", minLength: 1, maxLength: 256 }
      }
    )
  );
  register(
    app,
    objectSchema(
      "RollingBaseline",
      ["sampleSize", "meanAbsoluteMovement", "standardDeviation", "volatility"],
      {
        sampleSize: nonnegativeInteger,
        meanAbsoluteMovement: { type: "number", minimum: 0 },
        standardDeviation: { type: "number", minimum: 0 },
        volatility: { type: "number", minimum: 0 }
      }
    )
  );
  register(
    app,
    objectSchema(
      "MovementMetrics",
      [
        "probabilityDelta",
        "percentagePointMovement",
        "velocityPerSecond",
        "accelerationPerSecondSquared",
        "rollingBaseline"
      ],
      {
        probabilityDelta: finiteNumber,
        percentagePointMovement: finiteNumber,
        velocityPerSecond: finiteNumber,
        accelerationPerSecondSquared: finiteNumber,
        rollingBaseline: ref("RollingBaseline")
      }
    )
  );
  register(
    app,
    objectSchema(
      "CorrelatedEvent",
      ["event", "relationship", "sourceLagMs", "confirmationLeadMs"],
      {
        event: ref("MatchEvent"),
        relationship: {
          type: "string",
          enum: ["post_event_reaction", "late_event_confirmation"]
        },
        sourceLagMs: { type: "number", minimum: 0 },
        confirmationLeadMs: { type: "number", minimum: 0 }
      }
    )
  );
  register(
    app,
    objectSchema("FeedHealthState", ["status"], {
      status: { type: "string", enum: ["unknown", "healthy", "stale"] },
      lastReceivedTimestamp: timestamp,
      ageMs: { type: "number", minimum: 0 }
    })
  );
  register(
    app,
    objectSchema("FeedHealthSummary", ["status", "odds", "score"], {
      status: { type: "string", enum: ["unknown", "healthy", "degraded"] },
      odds: ref("FeedHealthState"),
      score: ref("FeedHealthState")
    })
  );
  register(
    app,
    objectSchema(
      "OperationalAlert",
      [
        "id",
        "type",
        "severity",
        "fixtureId",
        "feed",
        "timestamp",
        "message",
        "correlationId",
        "metadata"
      ],
      {
        id: generatedIdentifier,
        type: {
          type: "string",
          enum: [
            "stale_feed",
            "duplicate_update",
            "out_of_order_update",
            "sequence_gap",
            "delayed_update",
            "feed_recovery",
            "odds_score_divergence",
            "invalid_timestamp",
            "terminal_event_rejected",
            "malformed_payload"
          ]
        },
        severity: { type: "string", enum: ["info", "warning", "critical"] },
        fixtureId: externalIdentifier,
        feed: { type: "string", enum: ["odds", "score"] },
        timestamp,
        message: { type: "string", minLength: 1 },
        correlationId: { type: "string", minLength: 1 },
        metadata: {
          type: "object",
          additionalProperties: {
            oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
          }
        }
      }
    )
  );
  register(
    app,
    objectSchema("SignalExplanation", ["summary", "dataQuality", "decision", "reasons"], {
      summary: { type: "string", minLength: 1 },
      confirmedEvent: { type: "string", minLength: 1 },
      dataQuality: { type: "string", minLength: 1 },
      decision: { type: "string", minLength: 1 },
      reasons: { type: "array", items: { type: "string", minLength: 1 } }
    })
  );
  register(
    app,
    objectSchema(
      "CounterfactualPoint",
      [
        "horizonSeconds",
        "observedAt",
        "normalizedProbability",
        "probabilityChangeAfterSignal",
        "retainedMovementRatio",
        "observationLagSeconds",
        "classification"
      ],
      {
        horizonSeconds: { type: "integer", enum: [30, 60, 300] },
        observedAt: timestamp,
        normalizedProbability: probability,
        probabilityChangeAfterSignal: finiteNumber,
        retainedMovementRatio: finiteNumber,
        observationLagSeconds: { type: "number", minimum: 0 },
        classification: {
          type: "string",
          enum: ["persisted", "reversed", "inconclusive"]
        }
      }
    )
  );
  register(
    app,
    objectSchema("CounterfactualEvaluation", ["horizons", "immediateEntryOdds"], {
      horizons: { type: "array", items: ref("CounterfactualPoint"), maxItems: 3 },
      immediateEntryOdds: decimalOdds,
      confirmationEntryOdds: decimalOdds,
      confirmationDelaySeconds: { type: "number", minimum: 0 },
      movementAssessment: {
        type: "string",
        enum: ["persisted", "reversed", "inconclusive"]
      },
      immediateReturn: finiteNumber,
      confirmationReturn: finiteNumber,
      betterEntry: {
        type: "string",
        enum: ["immediate", "confirmation", "equal", "unavailable"]
      }
    })
  );
  register(
    app,
    objectSchema("ConfidenceComponent", ["component", "contribution"], {
      component: { type: "string", minLength: 1 },
      contribution: finiteNumber
    })
  );
  register(
    app,
    objectSchema("SignalOutcome", ["settledAt"], {
      settledAt: timestamp,
      positionOutcome: { type: "string", enum: ["won", "lost", "void"] },
      virtualPnl: finiteNumber
    })
  );
  register(
    app,
    objectSchema(
      "Signal",
      [
        "id",
        "correlationId",
        "fixtureId",
        "competition",
        "market",
        "selection",
        "sourceTimestamp",
        "receivedTimestamp",
        "matchMinute",
        "oddsBefore",
        "oddsAfter",
        "impliedProbabilityBefore",
        "impliedProbabilityAfter",
        "normalizedProbabilityBefore",
        "normalizedProbabilityAfter",
        "movement",
        "latencyMs",
        "ruleBasedConfidenceScore",
        "confidenceComponents",
        "triggeredRules",
        "explanation",
        "paperDecision",
        "strategyConfigurationVersion",
        "counterfactual"
      ],
      {
        id: generatedIdentifier,
        correlationId: { type: "string", minLength: 1 },
        fixtureId: externalIdentifier,
        competition: { type: "string", minLength: 1 },
        market: { type: "string", const: "match_winner" },
        selection,
        sourceTimestamp: timestamp,
        receivedTimestamp: timestamp,
        matchMinute: { type: "integer", minimum: 0, maximum: 130 },
        oddsBefore: decimalOdds,
        oddsAfter: decimalOdds,
        impliedProbabilityBefore: probability,
        impliedProbabilityAfter: probability,
        normalizedProbabilityBefore: probability,
        normalizedProbabilityAfter: probability,
        movement: ref("MovementMetrics"),
        correlatedEvent: ref("CorrelatedEvent"),
        latencyMs: { type: "number", minimum: 0 },
        ruleBasedConfidenceScore: probability,
        confidenceComponents: {
          type: "array",
          minItems: 1,
          items: ref("ConfidenceComponent")
        },
        triggeredRules: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true
        },
        explanation: ref("SignalExplanation"),
        paperDecision: {
          type: "string",
          enum: ["eligible", "opened", "declined", "not_eligible"]
        },
        strategyConfigurationVersion: { type: "string", minLength: 1 },
        counterfactual: ref("CounterfactualEvaluation"),
        outcome: ref("SignalOutcome")
      }
    )
  );
  register(
    app,
    objectSchema(
      "PaperPosition",
      [
        "id",
        "signalId",
        "fixtureId",
        "selection",
        "status",
        "stake",
        "entryOdds",
        "openedAt",
        "note"
      ],
      {
        id: generatedIdentifier,
        signalId: generatedIdentifier,
        fixtureId: externalIdentifier,
        selection,
        status: { type: "string", enum: ["open", "settled"] },
        stake: { type: "number", exclusiveMinimum: 0 },
        entryOdds: decimalOdds,
        openedAt: timestamp,
        settledAt: timestamp,
        outcome: { type: "string", enum: ["won", "lost", "void"] },
        virtualPnl: finiteNumber,
        note: { type: "string", const: "SIMULATION ONLY — NO REAL MONEY" }
      }
    )
  );
  register(
    app,
    objectSchema(
      "Analytics",
      [
        "virtualBankroll",
        "virtualPnl",
        "openExposure",
        "settledPositions",
        "winRate",
        "averageReturn",
        "maximumDrawdown",
        "maximumDrawdownPercent",
        "signalPrecision",
        "highRuleBasedConfidenceSignals"
      ],
      {
        virtualBankroll: { type: "number", minimum: 0 },
        virtualPnl: finiteNumber,
        openExposure: { type: "number", minimum: 0 },
        settledPositions: nonnegativeInteger,
        winRate: probability,
        averageReturn: finiteNumber,
        maximumDrawdown: { type: "number", minimum: 0 },
        maximumDrawdownPercent: probability,
        signalPrecision: probability,
        highRuleBasedConfidenceSignals: nonnegativeInteger
      }
    )
  );
  register(
    app,
    objectSchema(
      "AuditEvent",
      ["id", "sequence", "runId", "correlationId", "type", "timestamp", "data"],
      {
        id: generatedIdentifier,
        sequence: { type: "integer", minimum: 1 },
        runId: { type: "string", minLength: 1 },
        correlationId: { type: "string", minLength: 1 },
        type: {
          type: "string",
          enum: [
            "replay_control",
            "raw_input_reference",
            "normalized_input",
            "operational_alert",
            "signal_decision",
            "paper_execution",
            "counterfactual_evaluation",
            "settlement",
            "recovery",
            "error"
          ]
        },
        timestamp,
        data: { type: "object", additionalProperties: true }
      }
    )
  );
  register(
    app,
    objectSchema("AgentStatus", ["mode", "ready", "feedHealth", "auditEvents", "disclaimer"], {
      mode: { type: "string", enum: ["replay", "mock", "live"] },
      ready: { type: "boolean" },
      replay: ref("ReplayState"),
      fixture: ref("Fixture"),
      latestSignal: ref("Signal"),
      latestAlert: ref("OperationalAlert"),
      latestEvent: ref("MatchEvent"),
      latestConfirmedEvent: ref("MatchEvent"),
      latestOdds: ref("NormalizedOddsSnapshot"),
      feedHealth: ref("FeedHealthSummary"),
      auditEvents: nonnegativeInteger,
      disclaimer: { type: "string", const: "SIMULATION ONLY — NO REAL MONEY" }
    })
  );
  register(
    app,
    objectSchema("VerificationResult", ["status"], {
      status: { type: "string", enum: ["verified", "failed", "unavailable"] },
      method: { type: "string", minLength: 1 },
      checkedAt: timestamp,
      reason: { type: "string", minLength: 1, maxLength: 240 },
      fixtureId: externalIdentifier,
      proofTimestamp: timestamp,
      programId: { type: "string", minLength: 32, maxLength: 44 },
      rootAccount: { type: "string", minLength: 32, maxLength: 44 },
      sourceCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
      idlVersion: { type: "string", minLength: 1, maxLength: 32 },
      rpcSlot: nonnegativeInteger,
      computeUnits: { type: "integer", minimum: 0, maximum: 1_000_000 },
      simulation: { type: "string", const: "read-only-unsigned" }
    })
  );
  register(
    app,
    objectSchema("LiveStreamHealth", ["status", "reconnectAttempt"], {
      status: {
        type: "string",
        enum: ["disabled", "connecting", "connected", "reconnecting", "disconnected", "stopped"]
      },
      lastHeartbeatAt: timestamp,
      lastEventAt: timestamp,
      reconnectAttempt: nonnegativeInteger,
      error: { type: "string", minLength: 1, maxLength: 240 }
    })
  );
  register(
    app,
    objectSchema("LiveStreams", ["odds", "scores"], {
      odds: ref("LiveStreamHealth"),
      scores: ref("LiveStreamHealth")
    })
  );
  register(
    app,
    objectSchema(
      "LiveTxLineStatus",
      [
        "enabled",
        "network",
        "connected",
        "authenticated",
        "connectionStatus",
        "awaitingData",
        "streams",
        "verification",
        "updatedAt"
      ],
      {
        enabled: { type: "boolean" },
        network: { type: "string", const: "solana-devnet" },
        connected: { type: "boolean" },
        authenticated: { type: "boolean" },
        connectionStatus: {
          type: "string",
          enum: ["disabled", "connecting", "connected", "reconnecting", "disconnected", "stopped"]
        },
        awaitingData: { type: "boolean" },
        latestFixture: ref("LiveFixtureObservation"),
        latestOddsTimestamp: timestamp,
        latestScoreTimestamp: timestamp,
        streams: ref("LiveStreams"),
        verification: ref("VerificationResult"),
        lastError: { type: "string", minLength: 1, maxLength: 240 },
        updatedAt: timestamp
      }
    )
  );
  register(
    app,
    objectSchema("ReplayResponse", ["replay"], {
      replay: ref("ReplayState")
    })
  );
}

export const errorResponses = {
  400: { $ref: "Error#" },
  403: { $ref: "Error#" },
  409: { $ref: "Error#" }
} as const;

export const sessionCapacityErrorResponse = {
  503: { $ref: "ReplaySessionCapacityError#" }
} as const;
