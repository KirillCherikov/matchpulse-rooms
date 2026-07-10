import { z } from "zod";

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

export const oddsUpdateSchema = z.object({
  kind: z.literal("odds"),
  id: z.string().min(1),
  fixtureId: z.string().min(1),
  market: z.literal("match_winner"),
  sequence: z.number().int().nonnegative(),
  sourceTimestamp: timestampSchema,
  receivedTimestamp: timestampSchema,
  selections: z
    .array(
      z.object({
        selection: selectionSchema,
        decimalOdds: z.number().finite().gt(1)
      })
    )
    .length(3)
    .superRefine((selections, context) => {
      const unique = new Set(selections.map((selection) => selection.selection));
      if (unique.size !== selections.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Selections must be unique" });
      }
    }),
  rawReference: z.string().min(1)
});

export const matchEventSchema = z.object({
  kind: z.literal("score"),
  id: z.string().min(1),
  fixtureId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  sourceTimestamp: timestampSchema,
  receivedTimestamp: timestampSchema,
  type: matchEventTypeSchema,
  minute: z.number().int().min(0).max(130),
  team: z.enum(["home", "away"]).optional(),
  score: z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }).optional(),
  confirmed: z.boolean(),
  rawReference: z.string().min(1)
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
