import { describe, expect, it } from "vitest";
import {
  classifyProofVerification,
  decodeProofHash,
  encodeU16LittleEndian,
  epochDayFromProofTimestamp,
  fixtureRootWindowStartDay,
  normalizeProofNodes,
  txlineFixtureValidationSchema
} from "../../src/verification/txline-proof.js";

const checkedAt = "2026-07-12T00:00:00.000Z";

describe("TxLINE proof verification", () => {
  it("maps explicit on-chain outcomes without claiming unavailable checks are verified", () => {
    expect(
      classifyProofVerification({
        method: "validateFixture",
        checkedAt,
        proofAvailable: true,
        onChainAttempted: true,
        onChainValid: true
      })
    ).toEqual({ status: "verified", method: "validateFixture", checkedAt });

    expect(
      classifyProofVerification({
        method: "validateFixture",
        checkedAt,
        proofAvailable: true,
        onChainAttempted: true,
        onChainValid: false,
        reason: "InvalidMainTreeProof"
      })
    ).toEqual({
      status: "failed",
      method: "validateFixture",
      checkedAt,
      reason: "InvalidMainTreeProof"
    });

    expect(
      classifyProofVerification({
        method: "validateFixture",
        checkedAt,
        proofAvailable: false,
        onChainAttempted: false,
        reason: "No real fixture proof was available"
      })
    ).toEqual({
      status: "unavailable",
      method: "validateFixture",
      checkedAt,
      reason: "No real fixture proof was available"
    });
  });

  it("normalizes only exact 32-byte proof hashes", () => {
    const bytes = Array.from({ length: 32 }, (_, index) => index);
    const base64 = Buffer.from(bytes).toString("base64");
    const hex = `0x${Buffer.from(bytes).toString("hex")}`;

    expect(decodeProofHash(base64)).toEqual(bytes);
    expect(decodeProofHash(hex)).toEqual(bytes);
    expect(normalizeProofNodes([{ hash: bytes, isRightSibling: true }])).toEqual([
      { hash: bytes, isRightSibling: true }
    ]);
    expect(() => decodeProofHash(Buffer.alloc(31).toString("base64"))).toThrow(
      "Expected 32 proof bytes"
    );
    expect(() => decodeProofHash("not base64")).toThrow("canonical base64");
  });

  it("derives proof days from the proof timestamp with u16 bounds", () => {
    const timestamp = 20_625 * 86_400_000;
    expect(epochDayFromProofTimestamp(timestamp)).toBe(20_625);
    expect(fixtureRootWindowStartDay(timestamp)).toBe(20_620);
    expect([...encodeU16LittleEndian(20_620)]).toEqual([140, 80]);
    expect(() => epochDayFromProofTimestamp((0x1_0000 + 1) * 86_400_000)).toThrow(
      "outside the u16"
    );
  });

  it("fails closed when an official fixture proof shape is incomplete", () => {
    expect(() =>
      txlineFixtureValidationSchema.parse({
        snapshot: { FixtureId: 1 },
        summary: {},
        subTreeProof: [],
        mainTreeProof: []
      })
    ).toThrow();
  });
});
