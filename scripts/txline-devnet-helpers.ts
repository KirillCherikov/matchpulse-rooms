import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import { z } from "zod";

export const SERVICE_LEVEL_ID = 1;
export const DURATION_WEEKS = 4;
export const SELECTED_LEAGUES: number[] = [];
export const BROADCAST_CONFIRMATION = "DEVNET_TXLINE_SUBSCRIBE_1_4";

const SUBSCRIBE_DISCRIMINATOR = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]);

// Token-2022 account sizing mirrors the official SPL implementation's
// getAccountLenForMint mapping. Associated Token Account creation also adds the
// zero-length ImmutableOwner extension, so a mint without account-affecting
// extensions requires 165 + 1 + 4 = 170 bytes, not the legacy 165 bytes.
// Source reviewed at solana-program/token-2022 (ExtensionType and state layouts).
const TOKEN_ACCOUNT_BASE_SIZE = 165;
const TOKEN_2022_ACCOUNT_TYPE_SIZE = 1;
const TOKEN_2022_TLV_HEADER_SIZE = 4;
const TOKEN_2022_MULTISIG_SIZE = 355;
const TOKEN_2022_MINT_BASE_SIZE = 82;
const TOKEN_2022_MINT_ACCOUNT_TYPE = 1;
const TOKEN_2022_TOKEN_ACCOUNT_TYPE = 2;
const IMMUTABLE_OWNER_EXTENSION = 7;

const KNOWN_MINT_EXTENSIONS = new Set([
  1, // TransferFeeConfig
  3, // MintCloseAuthority
  4, // ConfidentialTransferMint
  6, // DefaultAccountState
  9, // NonTransferable
  10, // InterestBearingConfig
  12, // PermanentDelegate
  14, // TransferHook
  18, // MetadataPointer
  19, // TokenMetadata (variable length)
  20, // GroupPointer
  21, // TokenGroup
  22, // GroupMemberPointer
  23, // TokenGroupMember
  25, // ScaledUiAmountConfig
  26, // PausableConfig
  28 // PermissionedBurn
]);

const KNOWN_ACCOUNT_EXTENSIONS = new Set([
  2, // TransferFeeAmount
  5, // ConfidentialTransferAccount
  7, // ImmutableOwner
  8, // MemoTransfer
  11, // CpiGuard
  13, // NonTransferableAccount
  15, // TransferHookAccount
  27 // PausableAccount
]);

const MINT_TO_REQUIRED_ACCOUNT_EXTENSION = new Map<number, number>([
  [1, 2],
  [4, 5],
  [9, 13],
  [14, 15],
  [26, 27]
]);

const ACCOUNT_EXTENSION_DATA_SIZE = new Map<number, number>([
  [2, 8],
  [5, 295],
  [7, 0],
  [8, 1],
  [11, 1],
  [13, 0],
  [15, 1],
  [27, 0]
]);

const pinSchema = z
  .object({
    sourceRepository: z.literal("https://github.com/txodds/tx-on-chain.git"),
    commit: z.literal("9b2de4c30cf0f4e01c88d73c365543276d065cf2"),
    license: z.literal("Apache-2.0"),
    programId: z.literal("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlMint: z.literal("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    idlVersion: z.literal("1.5.6"),
    apiOpenApiVersion: z.literal("1.5.6"),
    openApi: z
      .object({
        url: z.literal("https://txline.txodds.com/docs/docs.yaml"),
        sha256: z.literal("41e18335a91f7a18eb7a173c2765a0c5450ba77754f491c343419e1ca25f1e9e")
      })
      .strict(),
    apiOrigin: z.literal("https://txline-dev.txodds.com"),
    rpcUrl: z.literal("https://api.devnet.solana.com"),
    idl: z.object({ path: z.string(), sha256: z.string().length(64) }).strict(),
    generatedTypes: z.object({ path: z.string(), sha256: z.string().length(64) }).strict(),
    tokenPrograms: z
      .object({
        token2022: z.literal("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
        associatedToken: z.literal("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      })
      .strict()
  })
  .strict();

export type TxLineDevnetPin = z.infer<typeof pinSchema>;

export interface SubscriptionAccounts {
  mint: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  pricingMatrix: PublicKey;
  tokenTreasuryPda: PublicKey;
  tokenTreasuryVault: PublicKey;
  userTokenAccount: PublicKey;
}

export interface SubscriptionInstructionSummary {
  name: "createAssociatedTokenAccount" | "subscribe";
  programId: string;
  accounts: Array<{
    address: string;
    signer: boolean;
    writable: boolean;
  }>;
}

export function parseDevnetPin(value: unknown): TxLineDevnetPin {
  return pinSchema.parse(value);
}

export function assertPinnedArtifact(
  path: string,
  bytes: Uint8Array,
  expectedSha256: string
): void {
  if (!/^examples\/devnet\/(?:idl|types)\/[A-Za-z0-9._-]+$/.test(path)) {
    throw new Error("Pinned TxLINE artifact path is outside the approved devnet directories");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(`Pinned TxLINE artifact hash mismatch for ${path}`);
  }
}

export function assertPinnedIdlContract(idl: unknown, pin: TxLineDevnetPin): void {
  const parsed = z
    .object({
      address: z.string(),
      metadata: z.object({ version: z.string() }).passthrough(),
      instructions: z.array(
        z
          .object({
            name: z.string(),
            discriminator: z.array(z.number().int().min(0).max(255)),
            accounts: z.array(
              z
                .object({
                  name: z.string(),
                  writable: z.boolean().optional(),
                  signer: z.boolean().optional()
                })
                .passthrough()
            ),
            args: z.array(z.object({ name: z.string(), type: z.unknown() }).passthrough())
          })
          .passthrough()
      )
    })
    .passthrough()
    .parse(idl);
  if (parsed.address !== pin.programId || parsed.metadata.version !== pin.idlVersion) {
    throw new Error("Pinned TxLINE IDL address or version does not match pin metadata");
  }
  const subscribe = parsed.instructions.find((instruction) => instruction.name === "subscribe");
  const expectedAccounts = [
    { name: "user", writable: true, signer: true },
    { name: "pricing_matrix", writable: false, signer: false },
    { name: "token_mint", writable: false, signer: false },
    { name: "user_token_account", writable: true, signer: false },
    { name: "token_treasury_vault", writable: true, signer: false },
    { name: "token_treasury_pda", writable: false, signer: false },
    { name: "token_program", writable: false, signer: false },
    { name: "system_program", writable: false, signer: false },
    { name: "associated_token_program", writable: false, signer: false }
  ];
  if (
    !subscribe ||
    !Buffer.from(subscribe.discriminator).equals(SUBSCRIBE_DISCRIMINATOR) ||
    subscribe.accounts.some((account, index) => {
      const expected = expectedAccounts[index];
      return (
        !expected ||
        account.name !== expected.name ||
        (account.writable ?? false) !== expected.writable ||
        (account.signer ?? false) !== expected.signer
      );
    }) ||
    subscribe.accounts.length !== expectedAccounts.length ||
    subscribe.args.length !== 2 ||
    subscribe.args[0]?.name !== "service_level_id" ||
    subscribe.args[0]?.type !== "u16" ||
    subscribe.args[1]?.name !== "weeks" ||
    subscribe.args[1]?.type !== "u8"
  ) {
    throw new Error("Pinned TxLINE IDL subscribe contract does not match the approved devnet flow");
  }
}

export function integerString(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "object" && value !== null && "toString" in value) {
    const result = String(value);
    if (/^-?\d+$/.test(result)) return result;
  }
  throw new Error("Pricing matrix contains a non-integer value");
}

export function assertFreeTierPricing(row: {
  rowId?: unknown;
  pricePerWeekToken?: unknown;
  samplingIntervalSec?: unknown;
  leagueBundleId?: unknown;
  marketBundleId?: unknown;
}): Record<string, string | number> {
  const rowId = integerString(row.rowId);
  const price = integerString(row.pricePerWeekToken);
  const sampling = integerString(row.samplingIntervalSec);
  const leagueBundle = integerString(row.leagueBundleId);
  const marketBundle = integerString(row.marketBundleId);
  if (rowId !== String(SERVICE_LEVEL_ID)) {
    throw new Error(`Free-tier safety check failed: pricing row is ${rowId}, expected 1`);
  }
  if (price !== "0" || sampling !== "0") {
    throw new Error(
      `Free-tier safety check failed: service level 1 price/sampling are ${price}/${sampling}, expected 0/0`
    );
  }
  if (leagueBundle !== "1" || marketBundle !== "2") {
    throw new Error(
      `Free-tier safety check failed: service level 1 bundles are ${leagueBundle}/${marketBundle}, expected 1/2`
    );
  }
  return {
    rowId: SERVICE_LEVEL_ID,
    pricePerWeekToken: price,
    samplingIntervalSec: sampling,
    leagueBundleId: leagueBundle,
    marketBundleId: marketBundle,
    durationWeeks: DURATION_WEEKS
  };
}

export function token2022MintTlvData(mintAccountData: Buffer): Buffer {
  if (mintAccountData.length < TOKEN_2022_MINT_BASE_SIZE) {
    throw new Error("Token-2022 mint account is smaller than the official mint layout");
  }
  if (mintAccountData[45] !== 1) {
    throw new Error("Token-2022 mint account is not initialized");
  }
  if (mintAccountData.length === TOKEN_2022_MINT_BASE_SIZE) return Buffer.alloc(0);
  if (
    mintAccountData.length <= TOKEN_ACCOUNT_BASE_SIZE ||
    mintAccountData.length === TOKEN_2022_MULTISIG_SIZE ||
    mintAccountData[TOKEN_ACCOUNT_BASE_SIZE] !== TOKEN_2022_MINT_ACCOUNT_TYPE
  ) {
    throw new Error("Token-2022 mint account has an incompatible extended layout");
  }
  return mintAccountData.subarray(TOKEN_ACCOUNT_BASE_SIZE + TOKEN_2022_ACCOUNT_TYPE_SIZE);
}

export function token2022AssociatedAccountLength(mintTlvData: Buffer): number {
  const mintExtensions = parseExtensionTypes(mintTlvData, KNOWN_MINT_EXTENSIONS, "mint");
  const requiredAccountExtensions = new Set<number>([IMMUTABLE_OWNER_EXTENSION]);
  for (const mintExtension of mintExtensions) {
    const accountExtension = MINT_TO_REQUIRED_ACCOUNT_EXTENSION.get(mintExtension);
    if (accountExtension !== undefined) requiredAccountExtensions.add(accountExtension);
  }

  let accountLength = TOKEN_ACCOUNT_BASE_SIZE + TOKEN_2022_ACCOUNT_TYPE_SIZE;
  for (const extension of requiredAccountExtensions) {
    const dataSize = ACCOUNT_EXTENSION_DATA_SIZE.get(extension);
    if (dataSize === undefined) {
      throw new Error(`Unsupported required Token-2022 account extension ${extension}`);
    }
    accountLength += TOKEN_2022_TLV_HEADER_SIZE + dataSize;
  }
  // The SPL layout reserves two bytes when an extension set would otherwise
  // collide exactly with the legacy multisig account size.
  return accountLength === TOKEN_2022_MULTISIG_SIZE ? accountLength + 2 : accountLength;
}

export function assertToken2022AssociatedAccountData(
  accountData: Buffer,
  expectedMint: PublicKey,
  expectedOwner: PublicKey,
  minimumLength: number,
  requiredMintTlvData: Buffer
): void {
  if (accountData.length < minimumLength || accountData.length <= TOKEN_ACCOUNT_BASE_SIZE) {
    throw new Error("Existing TxL associated token account has an incompatible size");
  }
  if (
    !new PublicKey(accountData.subarray(0, 32)).equals(expectedMint) ||
    !new PublicKey(accountData.subarray(32, 64)).equals(expectedOwner) ||
    ![1, 2].includes(accountData[108] ?? -1) ||
    accountData[TOKEN_ACCOUNT_BASE_SIZE] !== TOKEN_2022_TOKEN_ACCOUNT_TYPE
  ) {
    throw new Error("Existing TxL associated token account failed layout validation");
  }

  const existingExtensions = new Set(
    parseExtensionTypes(
      accountData.subarray(TOKEN_ACCOUNT_BASE_SIZE + TOKEN_2022_ACCOUNT_TYPE_SIZE),
      KNOWN_ACCOUNT_EXTENSIONS,
      "token account"
    )
  );
  const requiredExtensions = new Set<number>([IMMUTABLE_OWNER_EXTENSION]);
  for (const mintExtension of parseExtensionTypes(
    requiredMintTlvData,
    KNOWN_MINT_EXTENSIONS,
    "mint"
  )) {
    const accountExtension = MINT_TO_REQUIRED_ACCOUNT_EXTENSION.get(mintExtension);
    if (accountExtension !== undefined) requiredExtensions.add(accountExtension);
  }
  for (const extension of requiredExtensions) {
    if (!existingExtensions.has(extension)) {
      throw new Error(`Existing TxL account is missing required Token-2022 extension ${extension}`);
    }
  }
}

export function deriveAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve: boolean,
  tokenProgram: PublicKey,
  associatedTokenProgram: PublicKey
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error("Associated token account owner is off curve");
  }
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    associatedTokenProgram
  )[0];
}

export function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  associatedTokenProgram: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: associatedTokenProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false }
    ],
    data: Buffer.alloc(0)
  });
}

export function activationMessagePreimage(
  transactionSignature: string,
  selectedLeagues: number[],
  jwt: string
): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(transactionSignature)) {
    throw new Error("Invalid Solana transaction signature format");
  }
  z.array(z.number().int().nonnegative().max(65_535)).max(256).parse(selectedLeagues);
  z.string().min(16).max(16_384).parse(jwt);
  return `${transactionSignature}:${selectedLeagues.join(",")}:${jwt}`;
}

export type PublicTransactionReceiptStatus = "submitted" | "finalized";

export function publicTransactionReceipt(
  transactionSignature: string,
  status: PublicTransactionReceiptStatus
): { transactionSignature: string; status: PublicTransactionReceiptStatus } {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(transactionSignature)) {
    throw new Error("Invalid Solana transaction signature format");
  }
  return { transactionSignature, status };
}

export function assertBroadcastAuthorization(
  broadcast: boolean,
  confirmation: string | undefined
): boolean {
  if (!broadcast) return false;
  if (confirmation !== BROADCAST_CONFIRMATION) {
    throw new Error(
      `Broadcast refused: pass --confirm ${BROADCAST_CONFIRMATION} after explicit human approval`
    );
  }
  return true;
}

export function assertCredentialEnvPath(repositoryRoot: string, path: string): string {
  const absolutePath = resolve(path);
  const relativePath = relative(resolve(repositoryRoot), absolutePath);
  if (
    relativePath !== basename(relativePath) ||
    !/^\.env\.[A-Za-z0-9_-]+\.local$/.test(relativePath)
  ) {
    throw new Error("Credential env must be a root-level ignored .env.<name>.local file");
  }
  return absolutePath;
}

export function maskCredential(value: string): string {
  if (value.length < 12) return `<masked:${value.length}>`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

export function redactSensitiveText(error: unknown, values: Iterable<string>): string {
  let text = error instanceof Error ? error.message : String(error);
  const secrets = [...values].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const value of secrets) text = text.replaceAll(value, "<redacted>");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/X-Api-Token["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]+/gi, "X-Api-Token: <redacted>")
    .replace(/txoracle_api_[A-Za-z0-9._~-]+/gi, "<redacted-api-token>");
}

export function inspectSubscriptionInstructions(
  instructions: TransactionInstruction[],
  wallet: PublicKey,
  programId: PublicKey,
  accounts: SubscriptionAccounts,
  verifyInstructionFlags = true
): SubscriptionInstructionSummary[] {
  const includesAtaCreation = instructions.length === 2;
  if (instructions.length !== 1 && !includesAtaCreation) {
    throw new Error("Subscription safety check failed: unexpected instruction count");
  }
  const summaries: SubscriptionInstructionSummary[] = [];
  let subscribeIndex = 0;
  if (includesAtaCreation) {
    const instruction = instructions[0];
    if (!instruction) throw new Error("Subscription safety check failed: missing ATA instruction");
    assertInstruction(
      instruction,
      accounts.associatedTokenProgram,
      Buffer.alloc(0),
      [
        meta(wallet, true, true),
        meta(accounts.userTokenAccount, false, true),
        meta(wallet, false, false),
        meta(accounts.mint, false, false),
        meta(SystemProgram.programId, false, false),
        meta(accounts.tokenProgram, false, false)
      ],
      verifyInstructionFlags
    );
    summaries.push(summarize("createAssociatedTokenAccount", instruction));
    subscribeIndex = 1;
  }
  const subscribe = instructions[subscribeIndex];
  if (!subscribe)
    throw new Error("Subscription safety check failed: missing subscribe instruction");
  assertInstruction(
    subscribe,
    programId,
    Buffer.concat([
      SUBSCRIBE_DISCRIMINATOR,
      Buffer.from([SERVICE_LEVEL_ID & 0xff, SERVICE_LEVEL_ID >> 8, DURATION_WEEKS])
    ]),
    [
      meta(wallet, true, true),
      meta(accounts.pricingMatrix, false, false),
      meta(accounts.mint, false, false),
      meta(accounts.userTokenAccount, false, true),
      meta(accounts.tokenTreasuryVault, false, true),
      meta(accounts.tokenTreasuryPda, false, false),
      meta(accounts.tokenProgram, false, false),
      meta(SystemProgram.programId, false, false),
      meta(accounts.associatedTokenProgram, false, false)
    ],
    verifyInstructionFlags
  );
  summaries.push(summarize("subscribe", subscribe));
  return summaries;
}

function meta(address: PublicKey, signer: boolean, writable: boolean) {
  return { address, signer, writable };
}

function assertInstruction(
  instruction: TransactionInstruction,
  programId: PublicKey,
  data: Buffer,
  expectedAccounts: ReturnType<typeof meta>[],
  verifyFlags: boolean
): void {
  if (!instruction.programId.equals(programId) || !Buffer.from(instruction.data).equals(data)) {
    throw new Error("Subscription safety check failed: unauthorized program or instruction data");
  }
  if (instruction.keys.length !== expectedAccounts.length) {
    throw new Error("Subscription safety check failed: unexpected account count");
  }
  for (const [index, expected] of expectedAccounts.entries()) {
    const actual = instruction.keys[index];
    if (
      !actual ||
      !actual.pubkey.equals(expected.address) ||
      (verifyFlags &&
        (actual.isSigner !== expected.signer || actual.isWritable !== expected.writable))
    ) {
      throw new Error(`Subscription safety check failed: unexpected account at index ${index}`);
    }
  }
}

function summarize(
  name: SubscriptionInstructionSummary["name"],
  instruction: TransactionInstruction
): SubscriptionInstructionSummary {
  return {
    name,
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map((account) => ({
      address: account.pubkey.toBase58(),
      signer: account.isSigner,
      writable: account.isWritable
    }))
  };
}

function parseExtensionTypes(
  tlvData: Buffer,
  allowedTypes: ReadonlySet<number>,
  accountKind: string
): number[] {
  const types: number[] = [];
  const seen = new Set<number>();
  let offset = 0;
  while (offset < tlvData.length) {
    if (tlvData.length - offset < TOKEN_2022_TLV_HEADER_SIZE) {
      throw new Error(`Malformed Token-2022 ${accountKind} extension header`);
    }
    const type = tlvData.readUInt16LE(offset);
    const length = tlvData.readUInt16LE(offset + 2);
    const end = offset + TOKEN_2022_TLV_HEADER_SIZE + length;
    if (end > tlvData.length) {
      throw new Error(`Malformed Token-2022 ${accountKind} extension length`);
    }
    if (type === 0 && length === 0 && tlvData.subarray(offset).every((value) => value === 0)) {
      break;
    }
    if (!allowedTypes.has(type)) {
      throw new Error(`Unsupported Token-2022 ${accountKind} extension ${type}`);
    }
    if (seen.has(type)) {
      throw new Error(`Duplicate Token-2022 ${accountKind} extension ${type}`);
    }
    seen.add(type);
    types.push(type);
    offset = end;
  }
  return types;
}
