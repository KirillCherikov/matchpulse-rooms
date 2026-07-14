import { z } from "zod";

const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const nonnegativeInt32 = int32.nonnegative();
const int64 = z.number().int().safe();
const nonnegativeInt64 = int64.nonnegative();
const boundedText = z.string().min(1).max(512);
const optionalText = z.string().max(512).optional();

/** Official `Fixture` response from TxLINE OpenAPI 1.5.6. */
export const txLineFixtureSchema = z
  .object({
    Ts: nonnegativeInt64,
    StartTime: nonnegativeInt64,
    Competition: boundedText,
    CompetitionId: nonnegativeInt32,
    FixtureGroupId: nonnegativeInt32,
    Participant1Id: nonnegativeInt32,
    Participant1: boundedText,
    Participant2Id: nonnegativeInt32,
    Participant2: boundedText,
    FixtureId: nonnegativeInt64,
    Participant1IsHome: z.boolean(),
    /** Documented backward-compatible field used by the runnable examples. */
    GameState: z.union([z.literal(1), z.literal(6)]).optional(),
    /** Some official snapshot examples expose the same field in camel case. */
    gameState: z.union([z.literal(1), z.literal(6)]).optional()
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.GameState !== undefined &&
      record.gameState !== undefined &&
      record.GameState !== record.gameState
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gameState"],
        message: "TxLINE fixture GameState casing variants must agree"
      });
    }
  });

const pricePercentageSchema = z.string().regex(/^(?:NA|\d+\.\d{3})$/);

/** Official `OddsPayload` response. Integer `Prices` deliberately remain unscaled. */
export const txLineOddsSchema = z
  .object({
    FixtureId: nonnegativeInt64,
    MessageId: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          [...value].every((character) => {
            const code = character.codePointAt(0);
            return code !== undefined && code > 31 && code !== 127;
          }),
        "TxLINE MessageId must not contain control characters"
      ),
    Ts: nonnegativeInt64,
    Bookmaker: boundedText,
    BookmakerId: nonnegativeInt32,
    SuperOddsType: boundedText,
    GameState: optionalText.nullable(),
    InRunning: z.boolean(),
    MarketParameters: optionalText.nullable(),
    MarketPeriod: optionalText.nullable(),
    PriceNames: z.array(z.string().min(1).max(128)).max(64).optional(),
    Prices: z.array(int32).max(64).optional(),
    Pct: z.array(pricePercentageSchema).max(64).optional()
  })
  .strict()
  .superRefine((record, context) => {
    const lengths: Array<["PriceNames" | "Prices" | "Pct", number]> = [];
    if (record.PriceNames) lengths.push(["PriceNames", record.PriceNames.length]);
    if (record.Prices) lengths.push(["Prices", record.Prices.length]);
    if (record.Pct) lengths.push(["Pct", record.Pct.length]);
    const expectedLength = lengths[0]?.[1];
    for (const [field, length] of lengths.slice(1)) {
      if (length !== expectedLength) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "TxLINE PriceNames, Prices, and Pct arrays must align when present"
        });
      }
    }
  });

const txLineSoccerScoreSchema = z
  .object({
    Goals: nonnegativeInt32,
    YellowCards: nonnegativeInt32,
    RedCards: nonnegativeInt32,
    Corners: nonnegativeInt32
  })
  .strict();

const txLineSoccerTotalScoreSchema = z
  .object({
    H1: txLineSoccerScoreSchema.optional(),
    HT: txLineSoccerScoreSchema.optional(),
    H2: txLineSoccerScoreSchema.optional(),
    ET1: txLineSoccerScoreSchema.optional(),
    ET2: txLineSoccerScoreSchema.optional(),
    PE: txLineSoccerScoreSchema.optional(),
    ETTotal: txLineSoccerScoreSchema.optional(),
    Total: txLineSoccerScoreSchema.optional()
  })
  .strict();

const txLineSoccerFixtureScoreSchema = z
  .object({
    Participant1: txLineSoccerTotalScoreSchema,
    Participant2: txLineSoccerTotalScoreSchema
  })
  .strict();

const txLineSoccerDataSchema = z
  .object({
    Action: optionalText,
    Color: optionalText,
    Conditions: z.array(z.unknown()).max(64).optional(),
    New: z.unknown().optional(),
    Corner: z.boolean().optional(),
    FreeKickType: optionalText,
    Goal: z.boolean().optional(),
    GoalType: z.unknown().optional(),
    Minutes: z.number().int().min(0).max(180).optional(),
    Outcome: optionalText,
    Participant: nonnegativeInt32.optional(),
    Penalty: z.boolean().optional(),
    PlayerId: nonnegativeInt32.optional(),
    PlayerInId: nonnegativeInt32.optional(),
    PlayerOutId: nonnegativeInt32.optional(),
    Previous: z.unknown().optional(),
    StatusId: int32.optional(),
    ThrowInType: optionalText,
    Type: optionalText,
    RedCard: z.boolean().optional(),
    YellowCard: z.boolean().optional(),
    VAR: z.boolean().optional(),
    VenueType: z.unknown().optional()
  })
  .strict();

/**
 * Official `Scores` response. Every top-level OpenAPI property is declared so a
 * transport-incompatible field fails closed instead of being silently copied.
 * Nested sport payloads not consumed by Sentinel remain opaque but bounded at
 * the response-body level by the live provider.
 */
export const txLineScoreSchema = z
  .object({
    fixtureId: nonnegativeInt32,
    gameState: boundedText,
    startTime: nonnegativeInt64,
    isTeam: z.boolean(),
    fixtureGroupId: nonnegativeInt32,
    competitionId: nonnegativeInt32,
    countryId: nonnegativeInt32,
    sportId: nonnegativeInt32,
    participant1IsHome: z.boolean(),
    participant2Id: nonnegativeInt32,
    participant1Id: nonnegativeInt32,
    coverageSecondaryData: z.boolean().optional(),
    coverageType: optionalText,
    action: boundedText,
    id: nonnegativeInt32,
    ts: nonnegativeInt64,
    connectionId: nonnegativeInt64,
    seq: nonnegativeInt32.min(1),
    statusId: z.unknown().optional(),
    statusBasketballId: z.unknown().optional(),
    statusSoccerId: z.unknown().optional(),
    type: z.unknown().optional(),
    confirmed: z.boolean().optional(),
    clock: z.unknown().optional(),
    down: z.unknown().optional(),
    inPlayInfo: z.unknown().optional(),
    kickoffInfo: z.unknown().optional(),
    score: z.unknown().optional(),
    data: z.unknown().optional(),
    scoreBasketball: z.unknown().optional(),
    dataBasketball: z.unknown().optional(),
    scoreSoccer: txLineSoccerFixtureScoreSchema.optional(),
    dataSoccer: txLineSoccerDataSchema.optional(),
    stats: z.record(z.string(), int32).optional(),
    participant: nonnegativeInt32.optional(),
    kickoff: z.unknown().optional(),
    lineups: z.array(z.unknown()).max(256).optional(),
    possession: int32.optional(),
    possessionType: z.unknown().optional(),
    parti1StateSoccer: z.unknown().optional(),
    parti1StateUsFootball: z.unknown().optional(),
    parti1StateBasketball: z.unknown().optional(),
    parti2StateSoccer: z.unknown().optional(),
    parti2StateUsFootball: z.unknown().optional(),
    parti2StateBasketball: z.unknown().optional(),
    possibleEventSoccer: z.unknown().optional(),
    possibleEventUsFootball: z.unknown().optional(),
    playerStatsSoccer: z.unknown().optional(),
    playerStatsUsFootball: z.unknown().optional()
  })
  .strict();

export const txLineFixtureArraySchema = z.array(txLineFixtureSchema).max(10_000);
export const txLineOddsArraySchema = z.array(txLineOddsSchema).max(50_000);
export const txLineScoreArraySchema = z.array(txLineScoreSchema).max(50_000);

export const txLineHeartbeatSchema = z
  .object({
    Ts: nonnegativeInt64
  })
  .strict();

/** Parsed SSE transport envelope for the documented, non-data heartbeat event. */
export const txLineHeartbeatEnvelopeSchema = z
  .object({
    event: z.literal("heartbeat"),
    data: z.string().max(16_384),
    comments: z.array(z.string().max(1_024)).max(64),
    id: z.string().max(128).optional(),
    retry: nonnegativeInt32.optional()
  })
  .strict();

export const txLineGuestTokenSchema = z.object({ token: z.string().min(1).max(16_384) }).strict();

export type TxLineFixtureRecord = z.infer<typeof txLineFixtureSchema>;
export type TxLineOddsRecord = z.infer<typeof txLineOddsSchema>;
export type TxLineScoreRecord = z.infer<typeof txLineScoreSchema>;
