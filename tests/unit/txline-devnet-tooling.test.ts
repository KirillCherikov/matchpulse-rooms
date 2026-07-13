import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROADCAST_CONFIRMATION,
  activationMessagePreimage,
  assertBroadcastAuthorization,
  assertCredentialEnvPath,
  assertFreeTierPricing,
  assertPinnedArtifact,
  assertPinnedIdlContract,
  assertToken2022AssociatedAccountData,
  createAssociatedTokenAccountInstruction,
  inspectSubscriptionInstructions,
  parseDevnetPin,
  publicTransactionReceipt,
  redactSensitiveText,
  token2022AssociatedAccountLength,
  token2022MintTlvData,
  type SubscriptionAccounts
} from "../../scripts/txline-devnet-helpers.js";

describe("TxLINE devnet activation tooling", () => {
  it("pins the official devnet artifacts and rejects a hash or contract mismatch", async () => {
    const pin = parseDevnetPin(
      JSON.parse(await readFile(resolve("vendor/txline/devnet/pin.json"), "utf8"))
    );
    expect(pin).toMatchObject({
      commit: "9b2de4c30cf0f4e01c88d73c365543276d065cf2",
      programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
      idlVersion: "1.5.6",
      apiOpenApiVersion: "1.5.6",
      openApi: {
        sha256: "41e18335a91f7a18eb7a173c2765a0c5450ba77754f491c343419e1ca25f1e9e"
      },
      idl: {
        sha256: "1e7d55726eda9ad4d6ef62910fe5d7e007c687f4ff8b1c771a42b69b7089724e"
      },
      generatedTypes: {
        sha256: "1833b1137d3a4e249d7024df0393f760bfdab695ffeed9c1049134fd4eeb9889"
      }
    });

    const bytes = new TextEncoder().encode("official-pinned-artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(() =>
      assertPinnedArtifact("examples/devnet/idl/txoracle.json", bytes, digest)
    ).not.toThrow();
    expect(() =>
      assertPinnedArtifact("examples/devnet/idl/txoracle.json", bytes, "0".repeat(64))
    ).toThrow("hash mismatch");
    expect(() => assertPinnedArtifact("../txoracle.json", bytes, digest)).toThrow(
      "outside the approved"
    );

    const idl = {
      address: pin.programId,
      metadata: { version: pin.idlVersion },
      instructions: [
        {
          name: "subscribe",
          discriminator: [254, 28, 191, 138, 156, 179, 183, 53],
          accounts: [
            { name: "user", writable: true, signer: true },
            { name: "pricing_matrix" },
            { name: "token_mint" },
            { name: "user_token_account", writable: true },
            { name: "token_treasury_vault", writable: true },
            { name: "token_treasury_pda" },
            { name: "token_program" },
            { name: "system_program" },
            { name: "associated_token_program" }
          ],
          args: [
            { name: "service_level_id", type: "u16" },
            { name: "weeks", type: "u8" }
          ]
        }
      ]
    };
    expect(() => assertPinnedIdlContract(idl, pin)).not.toThrow();
    expect(() =>
      assertPinnedIdlContract(
        { ...idl, instructions: [{ ...idl.instructions[0], discriminator: [0] }] },
        pin
      )
    ).toThrow("subscribe contract");
    expect(() =>
      assertPinnedIdlContract(
        {
          ...idl,
          instructions: [
            {
              ...idl.instructions[0],
              accounts: idl.instructions[0]!.accounts.map((account, index) =>
                index === 1 ? { ...account, writable: true } : account
              )
            }
          ]
        },
        pin
      )
    ).toThrow("subscribe contract");
  });

  it("requires both free price and zero sampling interval", () => {
    const row = {
      rowId: 1,
      pricePerWeekToken: 0,
      samplingIntervalSec: 0,
      leagueBundleId: 1,
      marketBundleId: 2
    };
    expect(assertFreeTierPricing(row)).toMatchObject({
      rowId: 1,
      pricePerWeekToken: "0",
      samplingIntervalSec: "0",
      leagueBundleId: "1",
      marketBundleId: "2",
      durationWeeks: 4
    });
    expect(() => assertFreeTierPricing({ ...row, samplingIntervalSec: 60 })).toThrow(
      "expected 0/0"
    );
    expect(() => assertFreeTierPricing({ ...row, pricePerWeekToken: 1 })).toThrow("expected 0/0");
    expect(() => assertFreeTierPricing({ ...row, leagueBundleId: 2 })).toThrow("expected 1/2");
    expect(() => assertFreeTierPricing({ ...row, marketBundleId: 1 })).toThrow("expected 1/2");
  });

  it("derives Token-2022 ATA size from mint extensions and includes immutable owner", () => {
    expect(token2022AssociatedAccountLength(Buffer.alloc(0))).toBe(170);

    const extendedMint = Buffer.alloc(166 + 4 + 108);
    extendedMint[45] = 1;
    extendedMint[165] = 1;
    extendedMint.writeUInt16LE(1, 166);
    extendedMint.writeUInt16LE(108, 168);
    const mintTlvData = token2022MintTlvData(extendedMint);
    expect(token2022AssociatedAccountLength(mintTlvData)).toBe(182);

    const mint = key(17);
    const owner = key(18);
    const tokenAccount = Buffer.alloc(182);
    mint.toBuffer().copy(tokenAccount, 0);
    owner.toBuffer().copy(tokenAccount, 32);
    tokenAccount[108] = 1;
    tokenAccount[165] = 2;
    tokenAccount.writeUInt16LE(7, 166);
    tokenAccount.writeUInt16LE(0, 168);
    tokenAccount.writeUInt16LE(2, 170);
    tokenAccount.writeUInt16LE(8, 172);
    expect(() =>
      assertToken2022AssociatedAccountData(tokenAccount, mint, owner, 182, mintTlvData)
    ).not.toThrow();

    expect(() => token2022AssociatedAccountLength(Buffer.from([99, 0, 0, 0]))).toThrow(
      "Unsupported Token-2022 mint extension"
    );
    expect(() => token2022AssociatedAccountLength(Buffer.from([1, 0, 8, 0]))).toThrow(
      "Malformed Token-2022 mint extension length"
    );
  });

  it("uses the exact official activation preimage", () => {
    const txSig = "3".repeat(64);
    const jwt = "guest.jwt.value.with-safe-length";
    expect(activationMessagePreimage(txSig, [], jwt)).toBe(`${txSig}::${jwt}`);
    expect(activationMessagePreimage(txSig, [72, 91], jwt)).toBe(`${txSig}:72,91:${jwt}`);
  });

  it("defaults to no broadcast and requires the exact approval phrase", () => {
    expect(assertBroadcastAuthorization(false, undefined)).toBe(false);
    expect(() => assertBroadcastAuthorization(true, undefined)).toThrow("Broadcast refused");
    expect(assertBroadcastAuthorization(true, BROADCAST_CONFIRMATION)).toBe(true);
  });

  it("emits only a public signature and lifecycle status in transaction receipts", () => {
    const transactionSignature = "3".repeat(88);
    expect(publicTransactionReceipt(transactionSignature, "submitted")).toEqual({
      transactionSignature,
      status: "submitted"
    });
    expect(publicTransactionReceipt(transactionSignature, "finalized")).toEqual({
      transactionSignature,
      status: "finalized"
    });
    expect(() => publicTransactionReceipt("not-a-signature", "submitted")).toThrow(
      "Invalid Solana transaction signature format"
    );
  });

  it("only permits root-level ignored local credential files and redacts secrets", async () => {
    expect(await readFile(resolve(".gitignore"), "utf8")).toMatch(/^\.env\.\*$/m);
    expect(assertCredentialEnvPath(process.cwd(), ".env.live.local")).toBe(
      resolve(".env.live.local")
    );
    expect(() => assertCredentialEnvPath(process.cwd(), "README.md")).toThrow("root-level ignored");
    expect(() => assertCredentialEnvPath(process.cwd(), "tmp/.env.live.local")).toThrow(
      "root-level ignored"
    );

    const jwt = "eyJhbGciOi-secret.jwt.signature";
    const apiToken = "txoracle_api_super_secret";
    const redacted = redactSensitiveText(
      new Error(`Authorization: Bearer ${jwt}; X-Api-Token: ${apiToken}`),
      [jwt, apiToken]
    );
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain(apiToken);
    expect(redacted).toContain("<redacted>");
  });

  it("allows only the exact ATA-create and subscribe instructions", () => {
    const wallet = key(1);
    const programId = key(2);
    const accounts: SubscriptionAccounts = {
      mint: key(3),
      tokenProgram: key(4),
      associatedTokenProgram: key(5),
      pricingMatrix: key(6),
      tokenTreasuryPda: key(7),
      tokenTreasuryVault: key(8),
      userTokenAccount: key(9)
    };
    const ata = createAssociatedTokenAccountInstruction(
      wallet,
      accounts.userTokenAccount,
      wallet,
      accounts.mint,
      accounts.tokenProgram,
      accounts.associatedTokenProgram
    );
    const subscribe = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: accounts.pricingMatrix, isSigner: false, isWritable: false },
        { pubkey: accounts.mint, isSigner: false, isWritable: false },
        { pubkey: accounts.userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.tokenTreasuryVault, isSigner: false, isWritable: true },
        { pubkey: accounts.tokenTreasuryPda, isSigner: false, isWritable: false },
        { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false }
      ],
      data: Buffer.from([254, 28, 191, 138, 156, 179, 183, 53, 1, 0, 4])
    });

    expect(inspectSubscriptionInstructions([ata, subscribe], wallet, programId, accounts)).toEqual([
      expect.objectContaining({ name: "createAssociatedTokenAccount" }),
      expect.objectContaining({ name: "subscribe" })
    ]);
    expect(() =>
      inspectSubscriptionInstructions(
        [ata, new TransactionInstruction({ ...subscribe, data: Buffer.from([0]) })],
        wallet,
        programId,
        accounts
      )
    ).toThrow("unauthorized program or instruction data");
  });
});

function key(fill: number): PublicKey {
  return new PublicKey(Buffer.alloc(32, fill));
}
