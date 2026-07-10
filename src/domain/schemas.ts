import { z } from "zod";
import { MAX_DECIMAL_ODDS, MAX_EXTERNAL_IDENTIFIER_LENGTH } from "./constraints.js";

export const selectionSchema = z.enum(["home", "draw", "away"]);
export const matchEventTypeSchema = z.enum([
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
]);

const timestampSchema = z.string().datetime({ offset: true });
const rawReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?:synthetic|test|txline|sha256):[A-Za-z0-9._~:/-]+$/,
    "Raw references must be sanitized identifiers without queries, fragments, or credentials"
  )
  .refine(
    (value) => !/(?:authorization|bearer|jwt|token|secret|private[-_]?key)/i.test(value),
    "Raw references must not contain credential-related material"
  );

export const oddsUpdateSchema = z.object({
  kind: z.literal("odds"),
  id: z.string().min(1).max(MAX_EXTERNAL_IDENTIFIER_LENGTH),
  fixtureId: z.string().min(1).max(MAX_EXTERNAL_IDENTIFIER_LENGTH),
  market: z.literal("match_winner"),
  sequence: z.number().int().nonnegative(),
  sourceTimestamp: timestampSchema,
  receivedTimestamp: timestampSchema,
  selections: z
    .array(
      z.object({
        selection: selectionSchema,
        decimalOdds: z.number().finite().gt(1).lte(MAX_DECIMAL_ODDS)
      })
    )
    .length(3)
    .superRefine((selections, context) => {
      const unique = new Set(selections.map((selection) => selection.selection));
      if (unique.size !== selections.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Selections must be unique" });
      }
    }),
  rawReference: rawReferenceSchema
});

export const matchEventSchema = z.object({
  kind: z.literal("score"),
  id: z.string().min(1).max(MAX_EXTERNAL_IDENTIFIER_LENGTH),
  fixtureId: z.string().min(1).max(MAX_EXTERNAL_IDENTIFIER_LENGTH),
  sequence: z.number().int().nonnegative(),
  sourceTimestamp: timestampSchema,
  receivedTimestamp: timestampSchema,
  type: matchEventTypeSchema,
  minute: z.number().int().min(0).max(130),
  team: z.enum(["home", "away"]).optional(),
  score: z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).optional(),
  confirmed: z.boolean(),
  rawReference: rawReferenceSchema
});

export const providerMessageSchema = z.discriminatedUnion("kind", [
  oddsUpdateSchema,
  matchEventSchema
]);

export function parseProviderMessage(payload: unknown) {
  const parsed = providerMessageSchema.parse(payload);
  if (parsed.kind === "odds") {
    return parsed;
  }
  return {
    kind: parsed.kind,
    id: parsed.id,
    fixtureId: parsed.fixtureId,
    sequence: parsed.sequence,
    sourceTimestamp: parsed.sourceTimestamp,
    receivedTimestamp: parsed.receivedTimestamp,
    type: parsed.type,
    minute: parsed.minute,
    ...(parsed.team ? { team: parsed.team } : {}),
    ...(parsed.score ? { score: parsed.score } : {}),
    confirmed: parsed.confirmed,
    rawReference: parsed.rawReference
  };
}

export const replayControlSchema = z.object({
  speed: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]).optional()
});
