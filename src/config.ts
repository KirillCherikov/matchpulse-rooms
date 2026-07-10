import { z } from "zod";

const environmentSchema = z.object({
  SENTINEL_MODE: z.enum(["replay", "mock", "live"]).default("replay"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TXLINE_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  TXLINE_API_ORIGIN: z.string().url().optional(),
  TXLINE_GUEST_JWT: z.string().min(1).optional(),
  TXLINE_API_TOKEN: z.string().min(1).optional(),
  TELEGRAM_ENABLED: z.enum(["true", "false"]).default("false"),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_ALERT_CHAT_ID: z.string().min(1).optional()
});

export const SENTINEL_CONFIGURATION_VERSION = "2026-07-replay-mvp";

export interface SentinelConfig {
  mode: "replay" | "mock" | "live";
  port: number;
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
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
    minConfidenceToTrade: number;
    stakeFraction: number;
    maxExposureFraction: number;
    initialVirtualBankroll: number;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SentinelConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    mode: parsed.SENTINEL_MODE,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
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
      minConfidenceToTrade: 0.72,
      stakeFraction: 0.02,
      maxExposureFraction: 0.1,
      initialVirtualBankroll: 1_000
    }
  };
}
