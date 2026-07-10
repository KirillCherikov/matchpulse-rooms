import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);

const environmentSchema = z.object({
  SENTINEL_MODE: z.enum(["replay", "mock", "live"]).default("replay"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TXLINE_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  TXLINE_API_ORIGIN: optionalUrl,
  TXLINE_GUEST_JWT: optionalNonEmptyString,
  TXLINE_API_TOKEN: optionalNonEmptyString,
  CORS_ORIGIN: optionalUrl,
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  TELEGRAM_ENABLED: z.enum(["true", "false"]).default("false"),
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
  TELEGRAM_ALERT_CHAT_ID: optionalNonEmptyString
});

export const SENTINEL_CONFIGURATION_VERSION = "2026-07-replay-mvp";

export interface SentinelConfig {
  strategyConfigurationVersion: string;
  mode: "replay" | "mock" | "live";
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  corsOrigin?: string;
  secureSessionCookie: boolean;
  txline: {
    network: "devnet" | "mainnet-beta";
    apiOrigin?: string;
    guestJwt?: string;
    apiToken?: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
  };
  thresholds: {
    absoluteProbabilityMove: number;
    rapidVelocityPerSecond: number;
    correlationWindowMs: number;
    staleOddsMs: number;
    staleScoreMs: number;
    delayedUpdateMs: number;
    rollingWindowSize: number;
    baselineZScore: number;
    minRuleBasedConfidenceToTrade: number;
    highConfidenceNotificationScore: number;
    stakeFraction: number;
    maxExposureFraction: number;
    initialVirtualBankroll: number;
    counterfactualPersistenceRatio: number;
    counterfactualReversalRatio: number;
    counterfactualMaxObservationLagSeconds: number;
    seenIdLimitPerFeed: number;
  };
  confidenceWeights: {
    base: number;
    absoluteProbabilityShift: number;
    rapidProbabilityShift: number;
    abnormalRelativeToBaseline: number;
    momentumContinuation: number;
    confirmedMatchEvent: number;
    lateEventConfirmation: number;
    unexplainedMovement: number;
    warningPenalty: number;
    criticalPenalty: number;
    minimum: number;
    maximum: number;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SentinelConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    strategyConfigurationVersion: SENTINEL_CONFIGURATION_VERSION,
    mode: parsed.SENTINEL_MODE,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.CORS_ORIGIN ? { corsOrigin: parsed.CORS_ORIGIN } : {}),
    secureSessionCookie: parsed.SESSION_COOKIE_SECURE === "true",
    txline: {
      network: parsed.TXLINE_NETWORK,
      ...(parsed.TXLINE_API_ORIGIN ? { apiOrigin: parsed.TXLINE_API_ORIGIN } : {}),
      ...(parsed.TXLINE_GUEST_JWT ? { guestJwt: parsed.TXLINE_GUEST_JWT } : {}),
      ...(parsed.TXLINE_API_TOKEN ? { apiToken: parsed.TXLINE_API_TOKEN } : {})
    },
    telegram: {
      enabled: parsed.TELEGRAM_ENABLED === "true",
      ...(parsed.TELEGRAM_BOT_TOKEN ? { botToken: parsed.TELEGRAM_BOT_TOKEN } : {}),
      ...(parsed.TELEGRAM_ALERT_CHAT_ID ? { chatId: parsed.TELEGRAM_ALERT_CHAT_ID } : {})
    },
    thresholds: {
      absoluteProbabilityMove: 0.055,
      rapidVelocityPerSecond: 0.0015,
      correlationWindowMs: 45_000,
      staleOddsMs: 75_000,
      staleScoreMs: 60_000,
      delayedUpdateMs: 15_000,
      rollingWindowSize: 8,
      baselineZScore: 2,
      minRuleBasedConfidenceToTrade: 0.72,
      highConfidenceNotificationScore: 0.8,
      stakeFraction: 0.02,
      maxExposureFraction: 0.1,
      initialVirtualBankroll: 1_000,
      counterfactualPersistenceRatio: 0.6,
      counterfactualReversalRatio: 0,
      counterfactualMaxObservationLagSeconds: 30,
      seenIdLimitPerFeed: 1_000
    },
    confidenceWeights: {
      base: 0.32,
      absoluteProbabilityShift: 0.16,
      rapidProbabilityShift: 0.14,
      abnormalRelativeToBaseline: 0.08,
      momentumContinuation: 0.06,
      confirmedMatchEvent: 0.22,
      lateEventConfirmation: 0.04,
      unexplainedMovement: -0.03,
      warningPenalty: -0.12,
      criticalPenalty: -0.35,
      minimum: 0.05,
      maximum: 0.98
    }
  };
}
