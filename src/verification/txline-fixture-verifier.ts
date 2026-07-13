import {
  BPF_LOADER_PROGRAM_ID,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type RpcResponseAndContext,
  type SimulatedTransactionResponse,
  type SimulateTransactionConfig
} from "@solana/web3.js";
import { z } from "zod";
import type { LiveFixtureObservation, VerificationResult } from "../domain/models.js";
import { adaptTxLineFixture } from "../providers/txline-adapter.js";
import { txLineFixtureArraySchema, type TxLineFixtureRecord } from "../providers/txline-schemas.js";
import {
  decodeProofHash,
  encodeU16LittleEndian,
  fixtureRootWindowStartDay,
  normalizeProofNodes,
  pureFixtureId,
  txlineFixtureValidationSchema,
  type TxLineFixtureValidation
} from "./txline-proof.js";

export const TXLINE_DEVNET_PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
export const TXLINE_DEVNET_RPC_ORIGIN = "https://api.devnet.solana.com";
export const TXLINE_DEVNET_IDL_VERSION = "1.5.6";
export const TXLINE_DEVNET_SOURCE_COMMIT = "9b2de4c30cf0f4e01c88d73c365543276d065cf2";
export const TXLINE_DEVNET_IDL_SHA256 =
  "1e7d55726eda9ad4d6ef62910fe5d7e007c687f4ff8b1c771a42b69b7089724e";
export const TXLINE_DEVNET_TYPES_SHA256 =
  "1833b1137d3a4e249d7024df0393f760bfdab695ffeed9c1049134fd4eeb9889";

/**
 * Public key only. This is the user's disposable, funded devnet subscription
 * account. It is used solely as the fee-payer address in an unsigned
 * `sigVerify:false` simulation, exactly like TxLINE's official view-only
 * example. No signature is created and no transaction can be broadcast.
 */
export const TXLINE_DEVNET_SIMULATION_FEE_PAYER = "78nxT4D9E6iBZUuSRDQ4NDwDFtzcwpQ3FG8gokMfCsfh";

const VALIDATE_FIXTURE_DISCRIMINATOR = Buffer.from([231, 129, 218, 86, 223, 114, 21, 126]);
const COMMITMENT: Commitment = "confirmed";
const COMPUTE_UNIT_LIMIT = 1_000_000;
const MAX_HTTP_BODY_BYTES = 5_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_ATTEMPTS = 2;
const MIN_SIMULATION_FEE_PAYER_LAMPORTS = 5_000;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

const fixtureIdSchema = z.string().regex(/^\d{1,16}$/);
const guestJwtSchema = z.string().min(1).max(16_384);

export interface FixtureProofVerifier {
  verifyFixture(fixture: LiveFixtureObservation, signal?: AbortSignal): Promise<VerificationResult>;
}

export interface FixtureProofConnection {
  readonly rpcEndpoint: string;
  getAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment
  ): Promise<AccountInfo<Buffer> | null>;
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  simulateTransaction(
    transaction: VersionedTransaction,
    config?: SimulateTransactionConfig
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>>;
}

export interface TxLineFixtureVerifierOptions {
  apiOrigin: string;
  guestJwt: string;
  apiToken: string;
  fetch?: typeof fetch;
  connection?: FixtureProofConnection;
  now?: () => Date;
  requestTimeoutMs?: number;
  maxHttpAttempts?: number;
  simulationFeePayer?: string;
}

interface VerificationContext {
  fixtureId: string;
  proofTimestamp?: string;
  rootAccount?: string;
}

interface TimedHttpResponse {
  response: Response;
  deadlineAt: number;
}

/**
 * Fetches the official fixture proof and executes the pinned devnet
 * `validate_fixture` instruction through an unsigned, read-only simulation.
 * This class exposes no send/broadcast method and never receives a private key.
 */
export class TxLineFixtureVerifier implements FixtureProofVerifier {
  private readonly apiOrigin: string;
  private guestJwt: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly connection: FixtureProofConnection;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly maxHttpAttempts: number;
  private readonly feePayer: PublicKey;
  private readonly programId = new PublicKey(TXLINE_DEVNET_PROGRAM_ID);
  private readonly secrets = new Set<string>();

  public constructor(options: TxLineFixtureVerifierOptions) {
    this.apiOrigin = exactDevnetApiOrigin(options.apiOrigin);
    this.guestJwt = boundedCredential(options.guestJwt, "guest JWT");
    this.apiToken = boundedCredential(options.apiToken, "API token");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      100,
      60_000,
      "verification request timeout"
    );
    this.maxHttpAttempts = boundedInteger(
      options.maxHttpAttempts ?? DEFAULT_HTTP_ATTEMPTS,
      1,
      3,
      "verification HTTP attempt limit"
    );
    this.feePayer = new PublicKey(options.simulationFeePayer ?? TXLINE_DEVNET_SIMULATION_FEE_PAYER);
    this.connection =
      options.connection ??
      new Connection(TXLINE_DEVNET_RPC_ORIGIN, {
        commitment: COMMITMENT,
        disableRetryOnRateLimit: true
      });
    if (this.connection.rpcEndpoint !== TXLINE_DEVNET_RPC_ORIGIN) {
      throw new Error("Fixture verification is restricted to the pinned Solana devnet RPC");
    }
    this.secrets.add(this.guestJwt);
    this.secrets.add(this.apiToken);
  }

  public async verifyFixture(
    fixture: LiveFixtureObservation,
    signal?: AbortSignal
  ): Promise<VerificationResult> {
    const checkedAt = this.nowIso();
    const context: VerificationContext = { fixtureId: fixture.id };
    try {
      throwIfAborted(signal);
      fixtureIdSchema.parse(fixture.id);
      const observed = await this.findObservedFixture(fixture, signal);
      if (!observed) {
        throw new VerificationUnavailableError(
          "The observed fixture was no longer present in the authenticated TxLINE snapshot."
        );
      }
      const proof = await this.fetchProof(observed, signal);
      this.assertProofMatchesObservedFixture(proof, observed);
      context.proofTimestamp = epochMillisToIso(proof.snapshot.Ts);

      const rootAccount = this.deriveFixtureRoot(proof.snapshot.Ts);
      context.rootAccount = rootAccount.toBase58();
      const result = await this.simulateProof(proof, rootAccount, signal);
      const evidence = this.evidence(
        context,
        checkedAt,
        result.context.slot,
        result.value.unitsConsumed
      );
      const valid = decodeBooleanReturn(result.value, this.programId);
      if (!valid) {
        return {
          status: "failed",
          ...evidence,
          reason: "The on-chain validateFixture instruction returned false."
        };
      }
      return { status: "verified", ...evidence };
    } catch (error) {
      const evidence = this.evidence(context, checkedAt);
      if (error instanceof VerificationRejectedError) {
        return { status: "failed", ...evidence, reason: error.message };
      }
      if (isAbortError(error)) {
        return {
          status: "unavailable",
          ...evidence,
          reason: "Fixture verification was cancelled."
        };
      }
      return {
        status: "unavailable",
        ...evidence,
        reason:
          error instanceof VerificationUnavailableError
            ? error.message
            : "Fixture verification was unavailable due to a bounded transport failure."
      };
    }
  }

  private async findObservedFixture(
    fixture: LiveFixtureObservation,
    signal?: AbortSignal
  ): Promise<TxLineFixtureRecord | undefined> {
    const records = txLineFixtureArraySchema.parse(
      await this.authenticatedJson("/api/fixtures/snapshot", "snapshot", signal)
    );
    const numericId = Number(fixture.id);
    return records
      .filter((record) => {
        if (record.FixtureId !== numericId) return false;
        const adapted = adaptTxLineFixture(record, fixture.receivedTimestamp).fixture;
        return (
          adapted.id === fixture.id &&
          adapted.competition === fixture.competition &&
          adapted.homeTeam === fixture.homeTeam &&
          adapted.awayTeam === fixture.awayTeam &&
          adapted.status === fixture.status &&
          adapted.scheduledStartTimestamp === fixture.scheduledStartTimestamp &&
          adapted.sourceTimestamp === fixture.sourceTimestamp &&
          adapted.rawReference === fixture.rawReference &&
          adapted.dataLabel === fixture.dataLabel
        );
      })
      .toSorted((left, right) => right.Ts - left.Ts)[0];
  }

  private async fetchProof(
    observed: TxLineFixtureRecord,
    signal?: AbortSignal
  ): Promise<TxLineFixtureValidation> {
    const query = new URLSearchParams({
      fixtureId: String(observed.FixtureId),
      timestamp: String(observed.Ts)
    });
    const raw = await this.authenticatedJson(
      `/api/fixtures/validation?${query.toString()}`,
      "proof",
      signal
    );
    const parsed = txlineFixtureValidationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VerificationRejectedError(
        "The TxLINE fixture proof failed the pinned IDL 1.5.6 schema checks."
      );
    }
    return parsed.data;
  }

  private assertProofMatchesObservedFixture(
    proof: TxLineFixtureValidation,
    observed: TxLineFixtureRecord
  ): void {
    const snapshot = proof.snapshot;
    if (
      pureFixtureId(snapshot.FixtureId) !== observed.FixtureId ||
      snapshot.Ts !== observed.Ts ||
      snapshot.StartTime !== observed.StartTime ||
      snapshot.Competition !== observed.Competition ||
      snapshot.CompetitionId !== observed.CompetitionId ||
      snapshot.FixtureGroupId !== observed.FixtureGroupId ||
      snapshot.Participant1Id !== observed.Participant1Id ||
      snapshot.Participant1 !== observed.Participant1 ||
      snapshot.Participant2Id !== observed.Participant2Id ||
      snapshot.Participant2 !== observed.Participant2 ||
      snapshot.Participant1IsHome !== observed.Participant1IsHome
    ) {
      throw new VerificationRejectedError(
        "The TxLINE proof snapshot did not match the authenticated observed fixture."
      );
    }
  }

  private deriveFixtureRoot(timestampMs: number): PublicKey {
    const windowStartDay = fixtureRootWindowStartDay(timestampMs);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ten_daily_fixtures_roots"), Buffer.from(encodeU16LittleEndian(windowStartDay))],
      this.programId
    )[0];
  }

  private async simulateProof(
    proof: TxLineFixtureValidation,
    rootAccount: PublicKey,
    signal?: AbortSignal
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    const [programAccount, rootAccountInfo, feePayerAccount] = await withDeadline(
      Promise.all([
        this.connection.getAccountInfo(this.programId, COMMITMENT),
        this.connection.getAccountInfo(rootAccount, COMMITMENT),
        this.connection.getAccountInfo(this.feePayer, COMMITMENT)
      ]),
      this.requestTimeoutMs,
      signal
    );
    if (
      !programAccount?.executable ||
      (!programAccount.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID) &&
        !programAccount.owner.equals(BPF_LOADER_PROGRAM_ID))
    ) {
      throw new VerificationRejectedError(
        "The pinned TxLINE devnet program account was missing or incompatible."
      );
    }
    if (!rootAccountInfo) {
      throw new VerificationUnavailableError(
        "The matching TxLINE fixture-root account is not available on devnet yet."
      );
    }
    if (!rootAccountInfo.owner.equals(this.programId)) {
      throw new VerificationRejectedError(
        "The derived TxLINE fixture-root account had an unexpected owner."
      );
    }
    if (
      !feePayerAccount ||
      !feePayerAccount.owner.equals(SystemProgram.programId) ||
      feePayerAccount.data.length !== 0 ||
      feePayerAccount.lamports < MIN_SIMULATION_FEE_PAYER_LAMPORTS
    ) {
      throw new VerificationUnavailableError(
        "The public devnet simulation fee-payer account is unavailable."
      );
    }

    const recent = await withDeadline(
      this.connection.getLatestBlockhash(COMMITMENT),
      this.requestTimeoutMs,
      signal
    );
    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys: [{ pubkey: rootAccount, isSigner: false, isWritable: false }],
      data: encodeValidateFixtureInstruction(proof)
    });
    const legacy = new Transaction({
      feePayer: this.feePayer,
      recentBlockhash: recent.blockhash
    }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }), instruction);
    const transaction = new VersionedTransaction(legacy.compileMessage());
    if (
      transaction.signatures.length !== 1 ||
      transaction.signatures[0]?.some((byte) => byte !== 0)
    ) {
      throw new VerificationRejectedError(
        "The read-only verification transaction unexpectedly contained a signature."
      );
    }
    const simulation = await withDeadline(
      this.connection.simulateTransaction(transaction, {
        commitment: COMMITMENT,
        sigVerify: false
      }),
      this.requestTimeoutMs,
      signal
    );
    if (simulation.value.err !== null) {
      throw new VerificationRejectedError(
        "The on-chain validateFixture simulation rejected the supplied proof."
      );
    }
    if (
      !Number.isSafeInteger(simulation.value.unitsConsumed) ||
      (simulation.value.unitsConsumed ?? -1) < 0 ||
      (simulation.value.unitsConsumed ?? COMPUTE_UNIT_LIMIT + 1) > COMPUTE_UNIT_LIMIT
    ) {
      throw new VerificationRejectedError(
        "The validateFixture simulation returned invalid compute-unit evidence."
      );
    }
    return simulation;
  }

  private async authenticatedJson(
    path: string,
    kind: "snapshot" | "proof",
    signal?: AbortSignal
  ): Promise<unknown> {
    let renewed = false;
    for (let attempt = 1; attempt <= this.maxHttpAttempts; attempt += 1) {
      throwIfAborted(signal);
      const requested = await this.request(
        path,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.guestJwt}`,
            "x-api-token": this.apiToken
          }
        },
        signal
      );
      const { response } = requested;
      if (response.status === 401 && !renewed) {
        await response.body?.cancel().catch(() => undefined);
        await this.renewGuestJwt(signal);
        renewed = true;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxHttpAttempts) {
        await response.body?.cancel().catch(() => undefined);
        await abortableDelay(attempt * 100, signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (kind === "proof" && (response.status === 404 || response.status === 409)) {
          throw new VerificationUnavailableError(
            "TxLINE has not published a fixture proof for this observed record yet."
          );
        }
        throw new VerificationUnavailableError(
          `The authenticated TxLINE ${kind} request was unavailable (HTTP ${response.status}).`
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        await response.body?.cancel().catch(() => undefined);
        throw new VerificationRejectedError(
          `The authenticated TxLINE ${kind} response was not JSON.`
        );
      }
      return readBoundedJson(response, requested.deadlineAt, signal);
    }
    throw new VerificationUnavailableError(
      `The authenticated TxLINE ${kind} request exhausted its bounded retries.`
    );
  }

  private async renewGuestJwt(signal?: AbortSignal): Promise<void> {
    const requested = await this.request(
      "/auth/guest/start",
      { method: "POST", headers: { accept: "application/json" } },
      signal
    );
    const { response } = requested;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new VerificationUnavailableError(
        `TxLINE guest JWT renewal was unavailable (HTTP ${response.status}).`
      );
    }
    const value = z
      .object({ token: guestJwtSchema })
      .strict()
      .parse(await readBoundedJson(response, requested.deadlineAt, signal));
    this.guestJwt = boundedCredential(value.token, "renewed guest JWT");
    this.secrets.add(this.guestJwt);
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<TimedHttpResponse> {
    if (!path.startsWith("/api/") && path !== "/auth/guest/start") {
      throw new VerificationRejectedError("Refusing an undocumented TxLINE proof request path.");
    }
    const url = new URL(path, this.apiOrigin);
    if (url.origin !== this.apiOrigin) {
      throw new VerificationRejectedError("Refusing a cross-origin TxLINE proof request.");
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.requestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal
      });
      return { response, deadlineAt };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      void this.redact(error);
      throw new VerificationUnavailableError("The TxLINE proof request timed out or failed.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private evidence(
    context: VerificationContext,
    checkedAt: string,
    rpcSlot?: number,
    computeUnits?: number
  ): Omit<VerificationResult, "status" | "reason"> {
    return {
      method: "validateFixture",
      checkedAt,
      fixtureId: context.fixtureId,
      ...(context.proofTimestamp ? { proofTimestamp: context.proofTimestamp } : {}),
      programId: this.programId.toBase58(),
      ...(context.rootAccount ? { rootAccount: context.rootAccount } : {}),
      sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
      idlVersion: TXLINE_DEVNET_IDL_VERSION,
      ...(rpcSlot !== undefined ? { rpcSlot } : {}),
      ...(computeUnits !== undefined ? { computeUnits } : {}),
      simulation: "read-only-unsigned"
    };
  }

  private nowIso(): string {
    const now = this.now();
    if (!Number.isFinite(now.getTime()))
      throw new Error("Verification clock returned an invalid date");
    return now.toISOString();
  }

  private redact(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.secrets) message = message.replaceAll(secret, "[REDACTED]");
    return message
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/(?:txoracle_api_|api[_-]?token=)[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 240);
  }
}

export function encodeValidateFixtureInstruction(proof: TxLineFixtureValidation): Buffer {
  const writer = new BorshWriter();
  writer.writeBytes(VALIDATE_FIXTURE_DISCRIMINATOR);
  const { snapshot, summary } = proof;
  writer.writeI64(snapshot.Ts);
  writer.writeI64(snapshot.StartTime);
  writer.writeString(snapshot.Competition);
  writer.writeI32(snapshot.CompetitionId);
  writer.writeI32(snapshot.FixtureGroupId);
  writer.writeI32(snapshot.Participant1Id);
  writer.writeString(snapshot.Participant1);
  writer.writeI32(snapshot.Participant2Id);
  writer.writeString(snapshot.Participant2);
  writer.writeI64(snapshot.FixtureId);
  writer.writeBool(snapshot.Participant1IsHome);

  writer.writeI64(summary.fixtureId);
  writer.writeI32(summary.competitionId);
  writer.writeString(summary.competition);
  writer.writeU32(summary.updateStats.updateCount);
  writer.writeI64(summary.updateStats.minTimestamp);
  writer.writeI64(summary.updateStats.maxTimestamp);
  writer.writeBytes(Uint8Array.from(decodeProofHash(summary.updateSubTreeRoot)));
  writer.writeProofNodes(normalizeProofNodes(proof.subTreeProof));
  writer.writeProofNodes(normalizeProofNodes(proof.mainTreeProof));
  return writer.toBuffer();
}

function decodeBooleanReturn(value: SimulatedTransactionResponse, programId: PublicKey): boolean {
  const returned = value.returnData;
  if (!returned || returned.programId !== programId.toBase58() || returned.data[1] !== "base64") {
    throw new VerificationRejectedError(
      "The validateFixture simulation did not return pinned-program boolean evidence."
    );
  }
  const bytes = Buffer.from(returned.data[0], "base64");
  if (bytes.length !== 1 || bytes.toString("base64") !== returned.data[0]) {
    throw new VerificationRejectedError(
      "The validateFixture simulation returned malformed boolean evidence."
    );
  }
  if (bytes[0] === 1) return true;
  if (bytes[0] === 0) return false;
  throw new VerificationRejectedError(
    "The validateFixture simulation returned a non-boolean value."
  );
}

class BorshWriter {
  private readonly chunks: Buffer[] = [];

  public writeBytes(value: Uint8Array): void {
    this.chunks.push(Buffer.from(value));
  }

  public writeBool(value: boolean): void {
    this.chunks.push(Buffer.from([value ? 1 : 0]));
  }

  public writeI32(value: number): void {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeInt32LE(value);
    this.chunks.push(bytes);
  }

  public writeU32(value: number): void {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32LE(value);
    this.chunks.push(bytes);
  }

  public writeI64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new VerificationRejectedError("Fixture proof contained an invalid i64 value.");
    }
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeBigInt64LE(BigInt(value));
    this.chunks.push(bytes);
  }

  public writeString(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    this.writeU32(bytes.length);
    this.chunks.push(bytes);
  }

  public writeProofNodes(nodes: Array<{ hash: number[]; isRightSibling: boolean }>): void {
    this.writeU32(nodes.length);
    for (const node of nodes) {
      this.writeBytes(Uint8Array.from(node.hash));
      this.writeBool(node.isRightSibling);
    }
  }

  public toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class VerificationUnavailableError extends Error {}
class VerificationRejectedError extends Error {}

function exactDevnetApiOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://txline-dev.txodds.com" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Fixture verification requires the official TxLINE devnet API origin");
  }
  return url.origin;
}

function boundedCredential(value: string, label: string): string {
  const parsed = z.string().min(1).max(16_384).parse(value);
  if (/\s/.test(parsed)) throw new Error(`TxLINE ${label} must not contain whitespace`);
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function epochMillisToIso(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new VerificationRejectedError("Fixture proof timestamp was outside the ISO date range.");
  }
  return date.toISOString();
}

async function readBoundedJson(
  response: Response,
  deadlineAt: number,
  signal?: AbortSignal
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_HTTP_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new VerificationRejectedError("TxLINE proof response exceeded its size limit.");
  }
  if (!response.body) throw new VerificationRejectedError("TxLINE proof response had no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await withAbsoluteDeadline(reader.read(), deadlineAt, signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        throw new VerificationRejectedError("TxLINE proof response exceeded its size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new VerificationRejectedError("TxLINE proof response contained malformed JSON.");
  }
}

function withAbsoluteDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(
      new VerificationUnavailableError("The TxLINE HTTP response exceeded its absolute deadline.")
    );
  }
  return withDeadline(operation, remainingMs, signal);
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new VerificationUnavailableError("Verification operation timed out.")),
      timeoutMs
    );
    if (signal) {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return;
        onAbort();
      });
    }
  });
}
