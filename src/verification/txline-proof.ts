import { z } from "zod";
import type { VerificationResult } from "../domain/models.js";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const boundedText = z.string().min(1).max(512);
const PURE_FIXTURE_ID_MODULUS = 281_474_976_710_656;
const proofHashInputSchema = z.union([
  z.array(z.number().int().min(0).max(255)).length(32),
  z.instanceof(Uint8Array).refine((value) => value.length === 32, "Expected 32 proof bytes"),
  z.string().min(1).refine(isEncodedProofHash, "Proof hash must encode exactly 32 bytes")
]);

export const txlineProofNodeSchema = z
  .object({
    hash: proofHashInputSchema,
    isRightSibling: z.boolean()
  })
  .strict();

export const txlineProofFixtureSchema = z
  .object({
    Ts: nonnegativeSafeInteger,
    StartTime: nonnegativeSafeInteger,
    Competition: boundedText,
    CompetitionId: int32,
    FixtureGroupId: int32,
    Participant1Id: int32,
    Participant1: boundedText,
    Participant2Id: int32,
    Participant2: boundedText,
    FixtureId: nonnegativeSafeInteger,
    Participant1IsHome: z.boolean()
  })
  .strict();

const fixtureUpdateStatsSchema = z
  .object({
    updateCount: z.number().int().positive().max(0xffff_ffff),
    minTimestamp: nonnegativeSafeInteger,
    maxTimestamp: nonnegativeSafeInteger
  })
  .strict();

export const txlineFixtureValidationSchema = z
  .object({
    snapshot: txlineProofFixtureSchema,
    summary: z
      .object({
        fixtureId: nonnegativeSafeInteger,
        competitionId: int32,
        competition: boundedText,
        updateStats: fixtureUpdateStatsSchema,
        updateSubTreeRoot: proofHashInputSchema
      })
      .strict(),
    subTreeProof: z.array(txlineProofNodeSchema).max(64),
    mainTreeProof: z.array(txlineProofNodeSchema).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    const { snapshot, summary } = value;
    if (summary.fixtureId !== pureFixtureId(snapshot.FixtureId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "fixtureId"],
        message: "Fixture proof summary does not match the packed fixture identifier"
      });
    }
    if (
      summary.competitionId !== snapshot.CompetitionId ||
      summary.competition !== snapshot.Competition
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "competitionId"],
        message: "Fixture proof summary does not match the snapshot competition"
      });
    }
    if (
      summary.updateStats.minTimestamp > summary.updateStats.maxTimestamp ||
      snapshot.Ts < summary.updateStats.minTimestamp ||
      snapshot.Ts > summary.updateStats.maxTimestamp
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "updateStats"],
        message: "Fixture proof timestamps are internally inconsistent"
      });
    }
  });

export type TxLineFixtureValidation = z.infer<typeof txlineFixtureValidationSchema>;

export interface NormalizedProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface ProofVerificationEvidence {
  method: string;
  checkedAt: string;
  proofAvailable: boolean;
  onChainAttempted: boolean;
  onChainValid?: boolean;
  reason?: string;
}

export function decodeProofHash(value: z.infer<typeof proofHashInputSchema>): number[] {
  if (typeof value !== "string") {
    const bytes = Array.from(value);
    if (bytes.length !== 32) throw new Error("Expected 32 proof bytes");
    return bytes;
  }

  const bytes = value.startsWith("0x") ? decodeHexHash(value) : decodeCanonicalBase64Hash(value);
  if (bytes.length !== 32) throw new Error("Expected 32 proof bytes");
  return Array.from(bytes);
}

export function normalizeProofNodes(input: unknown): NormalizedProofNode[] {
  return z
    .array(txlineProofNodeSchema)
    .parse(input)
    .map((node) => ({
      hash: decodeProofHash(node.hash),
      isRightSibling: node.isRightSibling
    }));
}

export function epochDayFromProofTimestamp(timestampMs: number): number {
  const parsed = nonnegativeSafeInteger.parse(timestampMs);
  const epochDay = Math.floor(parsed / 86_400_000);
  if (epochDay > 0xffff) {
    throw new Error("Proof timestamp is outside the u16 epoch-day range");
  }
  return epochDay;
}

export function fixtureRootWindowStartDay(timestampMs: number): number {
  const epochDay = epochDayFromProofTimestamp(timestampMs);
  return Math.floor(epochDay / 10) * 10;
}

export function pureFixtureId(value: number): number {
  return nonnegativeSafeInteger.parse(value) % PURE_FIXTURE_ID_MODULUS;
}

export function encodeU16LittleEndian(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("Expected an unsigned 16-bit integer");
  }
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

export function classifyProofVerification(evidence: ProofVerificationEvidence): VerificationResult {
  const base = {
    method: evidence.method,
    checkedAt: evidence.checkedAt
  };

  if (!evidence.proofAvailable || !evidence.onChainAttempted) {
    return {
      status: "unavailable",
      ...base,
      ...(evidence.reason ? { reason: evidence.reason } : {})
    };
  }

  if (evidence.onChainValid === true) {
    return { status: "verified", ...base };
  }

  return {
    status: "failed",
    ...base,
    reason: evidence.reason ?? "On-chain proof validation did not return true"
  };
}

function decodeHexHash(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Proof hash must be exactly 32 hexadecimal bytes");
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function decodeCanonicalBase64Hash(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Proof hash must be canonical base64 or 0x-prefixed hexadecimal");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Proof hash must use canonical base64 encoding");
  }
  return Uint8Array.from(decoded);
}

function isEncodedProofHash(value: string): boolean {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}
