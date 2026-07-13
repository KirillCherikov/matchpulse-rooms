import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  BPF_LOADER_PROGRAM_ID,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type RpcResponseAndContext,
  type SimulatedTransactionResponse,
  type SimulateTransactionConfig,
  type VersionedTransaction
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { LiveFixtureObservation } from "../../src/domain/models.js";
import type { TxLineFixtureValidation } from "../../src/verification/txline-proof.js";
import {
  TXLINE_DEVNET_IDL_VERSION,
  TXLINE_DEVNET_PROGRAM_ID,
  TXLINE_DEVNET_RPC_ORIGIN,
  TXLINE_DEVNET_SIMULATION_FEE_PAYER,
  TXLINE_DEVNET_SOURCE_COMMIT,
  TxLineFixtureVerifier,
  type FixtureProofConnection
} from "../../src/verification/txline-fixture-verifier.js";

describe("runtime TxLINE fixture verifier", () => {
  it("encodes the exact pinned IDL layout and verifies through unsigned sigVerify:false simulation", async () => {
    const connection = new FakeProofConnection();
    const fetch = officialFetch();
    const verifier = verifierWith({ connection, fetch });

    const result = await verifier.verifyFixture(fixture);

    expect(result).toMatchObject({
      status: "verified",
      method: "validateFixture",
      checkedAt: CHECKED_AT,
      fixtureId: String(FIXTURE_ID),
      proofTimestamp: new Date(TIMESTAMP).toISOString(),
      programId: TXLINE_DEVNET_PROGRAM_ID,
      sourceCommit: TXLINE_DEVNET_SOURCE_COMMIT,
      idlVersion: TXLINE_DEVNET_IDL_VERSION,
      rpcSlot: 812_345,
      computeUnits: 241_337,
      simulation: "read-only-unsigned"
    });
    expect(result.rootAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(connection.simulations).toHaveLength(1);
    const simulation = connection.simulations[0]!;
    expect(simulation.config).toMatchObject({ commitment: "confirmed", sigVerify: false });
    expect(simulation.transaction.signatures).toHaveLength(1);
    expect([...simulation.transaction.signatures[0]!]).toEqual(new Array(64).fill(0));

    const compiled = simulation.transaction.message.compiledInstructions;
    expect(compiled).toHaveLength(2);
    const customEncoded = Buffer.from(compiled[1]!.data);
    expect(customEncoded).toEqual(anchorEncodedInstruction(proof));
  });

  it("reports explicit verification failure for a false program return and malformed proof", async () => {
    const falseConnection = new FakeProofConnection();
    falseConnection.returnValue = false;
    const falseResult = await verifierWith({
      connection: falseConnection,
      fetch: officialFetch()
    }).verifyFixture(fixture);
    expect(falseResult).toMatchObject({
      status: "failed",
      reason: "The on-chain validateFixture instruction returned false."
    });

    const malformedFetch = officialFetch({
      ...proof,
      summary: { ...proof.summary, updateSubTreeRoot: Buffer.alloc(31).toString("base64") }
    });
    const malformedConnection = new FakeProofConnection();
    const malformed = await verifierWith({
      connection: malformedConnection,
      fetch: malformedFetch
    }).verifyFixture(fixture);
    expect(malformed).toMatchObject({
      status: "failed",
      reason: "The TxLINE fixture proof failed the pinned IDL 1.5.6 schema checks."
    });
    expect(malformedConnection.simulations).toHaveLength(0);
  });

  it("refuses to verify a newer record when the displayed fixture observation is older", async () => {
    const connection = new FakeProofConnection();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/fixtures/snapshot") {
        return jsonResponse([{ ...observedApiFixture, Ts: TIMESTAMP + 1_000 }]);
      }
      throw new Error(`Unexpected proof request ${url.pathname}`);
    });

    const result = await verifierWith({ connection, fetch }).verifyFixture(fixture);

    expect(result).toMatchObject({
      status: "unavailable",
      fixtureId: String(FIXTURE_ID),
      reason: "The observed fixture was no longer present in the authenticated TxLINE snapshot."
    });
    expect(connection.simulations).toHaveLength(0);
  });

  it("renews a guest JWT once without exposing either credential", async () => {
    const connection = new FakeProofConnection();
    const renewedJwt = "renewed-test-guest-jwt";
    const apiToken = "synthetic-test-api-token";
    let snapshotCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/guest/start") {
        return jsonResponse({ token: renewedJwt });
      }
      if (url.pathname === "/api/fixtures/snapshot") {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return new Response(undefined, { status: 401 });
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${renewedJwt}`);
        return jsonResponse([observedApiFixture]);
      }
      if (url.pathname === "/api/fixtures/validation") return jsonResponse(proof);
      return new Response(undefined, { status: 404 });
    });
    const result = await new TxLineFixtureVerifier({
      apiOrigin: "https://txline-dev.txodds.com",
      guestJwt: "expired-test-guest-jwt",
      apiToken,
      connection,
      fetch,
      now: () => new Date(CHECKED_AT),
      requestTimeoutMs: 1_000
    }).verifyFixture(fixture);

    expect(result.status).toBe("verified");
    expect(JSON.stringify(result)).not.toContain(renewedJwt);
    expect(JSON.stringify(result)).not.toContain(apiToken);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps missing roots, cancellation, and credential-bearing failures unavailable", async () => {
    const missingRootConnection = new FakeProofConnection();
    missingRootConnection.rootAvailable = false;
    const missingRoot = await verifierWith({
      connection: missingRootConnection,
      fetch: officialFetch()
    }).verifyFixture(fixture);
    expect(missingRoot).toMatchObject({
      status: "unavailable",
      reason: "The matching TxLINE fixture-root account is not available on devnet yet."
    });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await verifierWith({
      connection: new FakeProofConnection(),
      fetch: officialFetch()
    }).verifyFixture(fixture, controller.signal);
    expect(cancelled).toMatchObject({
      status: "unavailable",
      reason: "Fixture verification was cancelled."
    });

    const leaked = "synthetic-test-api-token";
    const failedFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(`Bearer expired-test-guest-jwt token=${leaked}`);
    });
    const failure = await verifierWith({
      connection: new FakeProofConnection(),
      fetch: failedFetch
    }).verifyFixture(fixture);
    expect(failure.status).toBe("unavailable");
    expect(JSON.stringify(failure)).not.toContain(leaked);
    expect(JSON.stringify(failure)).not.toContain("expired-test-guest-jwt");
  });

  it("applies one absolute deadline to a slow-drip authenticated JSON body", async () => {
    let chunks = 0;
    const cancellation = new AbortController();
    const verifier = new TxLineFixtureVerifier({
      apiOrigin: "https://txline-dev.txodds.com",
      guestJwt: "synthetic-test-guest-jwt",
      apiToken: "synthetic-test-api-token",
      connection: new FakeProofConnection(),
      fetch: vi.fn<typeof globalThis.fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/fixtures/snapshot") {
          return slowDripJson(() => {
            chunks += 1;
          });
        }
        return new Response(undefined, { status: 404 });
      }),
      now: () => new Date(CHECKED_AT),
      requestTimeoutMs: 100,
      maxHttpAttempts: 1
    });

    try {
      const result = await valueWithin(verifier.verifyFixture(fixture, cancellation.signal), 750);
      expect(result).toMatchObject({
        status: "unavailable",
        reason: expect.stringMatching(/timed out|absolute deadline/)
      });
      expect(chunks).toBeGreaterThan(1);
    } finally {
      cancellation.abort();
    }
  });
});

const CHECKED_AT = "2026-07-13T12:00:00.000Z";
const TIMESTAMP = Date.parse("2026-07-13T11:55:00.000Z");
const FIXTURE_ID = 18_175_981;
const PACKED_FIXTURE_ID = 281_474_976_710_656 + FIXTURE_ID;
const hash = Array.from({ length: 32 }, (_, index) => index);

const fixture: LiveFixtureObservation = {
  id: String(FIXTURE_ID),
  competition: "Official competition",
  homeTeam: "Home",
  awayTeam: "Away",
  status: "scheduled",
  scheduledStartTimestamp: new Date(TIMESTAMP + 3_600_000).toISOString(),
  sourceTimestamp: new Date(TIMESTAMP).toISOString(),
  receivedTimestamp: CHECKED_AT,
  rawReference: `txline://fixtures/${FIXTURE_ID}/${TIMESTAMP}`,
  dataLabel: "Live TxLINE devnet data"
};

const observedFixture = {
  Ts: TIMESTAMP,
  StartTime: TIMESTAMP + 3_600_000,
  Competition: "Official competition",
  CompetitionId: 91,
  FixtureGroupId: 42,
  Participant1Id: 100,
  Participant1: "Home",
  Participant2Id: 200,
  Participant2: "Away",
  FixtureId: FIXTURE_ID,
  Participant1IsHome: true
};

const observedApiFixture = { ...observedFixture, GameState: 1 as const };

const proof: TxLineFixtureValidation = {
  snapshot: { ...observedFixture, FixtureId: PACKED_FIXTURE_ID },
  summary: {
    fixtureId: FIXTURE_ID,
    competitionId: 91,
    competition: "Official competition",
    updateStats: {
      updateCount: 1,
      minTimestamp: TIMESTAMP,
      maxTimestamp: TIMESTAMP
    },
    updateSubTreeRoot: hash
  },
  subTreeProof: [{ hash, isRightSibling: false }],
  mainTreeProof: [{ hash: Buffer.from(hash).toString("base64"), isRightSibling: true }]
};

class FakeProofConnection implements FixtureProofConnection {
  public readonly rpcEndpoint = TXLINE_DEVNET_RPC_ORIGIN;
  public readonly simulations: Array<{
    transaction: VersionedTransaction;
    config?: SimulateTransactionConfig;
  }> = [];
  public rootAvailable = true;
  public returnValue = true;

  public async getAccountInfo(publicKey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    if (publicKey.equals(new PublicKey(TXLINE_DEVNET_PROGRAM_ID))) {
      return account(BPF_LOADER_PROGRAM_ID, Buffer.from([1]), 1, true);
    }
    if (publicKey.equals(new PublicKey(TXLINE_DEVNET_SIMULATION_FEE_PAYER))) {
      return account(SystemProgram.programId, Buffer.alloc(0), 10_000_000, false);
    }
    return this.rootAvailable
      ? account(new PublicKey(TXLINE_DEVNET_PROGRAM_ID), Buffer.alloc(32), 1_000_000, false)
      : null;
  }

  public async getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  }

  public async simulateTransaction(
    transaction: VersionedTransaction,
    config?: SimulateTransactionConfig
  ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
    this.simulations.push({ transaction, ...(config ? { config } : {}) });
    return {
      context: { slot: 812_345 },
      value: {
        err: null,
        logs: [],
        accounts: null,
        unitsConsumed: 241_337,
        returnData: {
          programId: TXLINE_DEVNET_PROGRAM_ID,
          data: [Buffer.from([this.returnValue ? 1 : 0]).toString("base64"), "base64"]
        }
      }
    };
  }
}

function verifierWith(options: {
  connection: FixtureProofConnection;
  fetch: typeof globalThis.fetch;
}): TxLineFixtureVerifier {
  return new TxLineFixtureVerifier({
    apiOrigin: "https://txline-dev.txodds.com",
    guestJwt: "synthetic-test-guest-jwt",
    apiToken: "synthetic-test-api-token",
    connection: options.connection,
    fetch: options.fetch,
    now: () => new Date(CHECKED_AT),
    requestTimeoutMs: 1_000
  });
}

function officialFetch(
  validation: unknown = proof
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://txline-dev.txodds.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-test-guest-jwt");
    expect(new Headers(init?.headers).get("x-api-token")).toBe("synthetic-test-api-token");
    if (url.pathname === "/api/fixtures/snapshot") return jsonResponse([observedApiFixture]);
    if (url.pathname === "/api/fixtures/validation") {
      expect(url.searchParams.get("fixtureId")).toBe(String(FIXTURE_ID));
      expect(url.searchParams.get("timestamp")).toBe(String(TIMESTAMP));
      return jsonResponse(validation);
    }
    return new Response(undefined, { status: 404 });
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function slowDripJson(onChunk: () => void): Response {
  const bytes = new TextEncoder().encode(" ");
  let cancelled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancelled) return;
        onChunk();
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function valueWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture verifier exceeded its absolute test deadline")),
      timeoutMs
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function account(
  owner: PublicKey,
  data: Buffer,
  lamports: number,
  executable: boolean
): AccountInfo<Buffer> {
  return { owner, data, lamports, executable, rentEpoch: 0 };
}

function anchorEncodedInstruction(value: TxLineFixtureValidation): Buffer {
  const coder = new BorshInstructionCoder(minimalFixtureIdl);
  return coder.encode("validate_fixture", {
    snapshot: {
      ts: new BN(value.snapshot.Ts),
      start_time: new BN(value.snapshot.StartTime),
      competition: value.snapshot.Competition,
      competition_id: value.snapshot.CompetitionId,
      fixture_group_id: value.snapshot.FixtureGroupId,
      participant1_id: value.snapshot.Participant1Id,
      participant1: value.snapshot.Participant1,
      participant2_id: value.snapshot.Participant2Id,
      participant2: value.snapshot.Participant2,
      fixture_id: new BN(value.snapshot.FixtureId),
      participant1_is_home: value.snapshot.Participant1IsHome
    },
    summary: {
      fixture_id: new BN(value.summary.fixtureId),
      competition_id: value.summary.competitionId,
      competition: value.summary.competition,
      update_stats: {
        update_count: value.summary.updateStats.updateCount,
        min_timestamp: new BN(value.summary.updateStats.minTimestamp),
        max_timestamp: new BN(value.summary.updateStats.maxTimestamp)
      },
      update_sub_tree_root: value.summary.updateSubTreeRoot
    },
    sub_tree_proof: value.subTreeProof.map((node) => ({
      hash: node.hash,
      is_right_sibling: node.isRightSibling
    })),
    main_tree_proof: value.mainTreeProof.map((node) => ({
      hash: typeof node.hash === "string" ? [...Buffer.from(node.hash, "base64")] : node.hash,
      is_right_sibling: node.isRightSibling
    }))
  });
}

const minimalFixtureIdl = {
  address: TXLINE_DEVNET_PROGRAM_ID,
  metadata: { name: "txoracle", version: TXLINE_DEVNET_IDL_VERSION, spec: "0.1.0" },
  instructions: [
    {
      name: "validate_fixture",
      discriminator: [231, 129, 218, 86, 223, 114, 21, 126],
      accounts: [{ name: "ten_daily_fixtures_roots" }],
      args: [
        { name: "snapshot", type: { defined: { name: "Fixture" } } },
        { name: "summary", type: { defined: { name: "FixtureBatchSummary" } } },
        {
          name: "sub_tree_proof",
          type: { vec: { defined: { name: "ProofNode" } } }
        },
        {
          name: "main_tree_proof",
          type: { vec: { defined: { name: "ProofNode" } } }
        }
      ]
    }
  ],
  accounts: [],
  events: [],
  errors: [],
  types: [
    {
      name: "Fixture",
      type: {
        kind: "struct",
        fields: [
          { name: "ts", type: "i64" },
          { name: "start_time", type: "i64" },
          { name: "competition", type: "string" },
          { name: "competition_id", type: "i32" },
          { name: "fixture_group_id", type: "i32" },
          { name: "participant1_id", type: "i32" },
          { name: "participant1", type: "string" },
          { name: "participant2_id", type: "i32" },
          { name: "participant2", type: "string" },
          { name: "fixture_id", type: "i64" },
          { name: "participant1_is_home", type: "bool" }
        ]
      }
    },
    {
      name: "FixtureBatchSummary",
      type: {
        kind: "struct",
        fields: [
          { name: "fixture_id", type: "i64" },
          { name: "competition_id", type: "i32" },
          { name: "competition", type: "string" },
          { name: "update_stats", type: { defined: { name: "FixtureUpdateStats" } } },
          { name: "update_sub_tree_root", type: { array: ["u8", 32] } }
        ]
      }
    },
    {
      name: "FixtureUpdateStats",
      type: {
        kind: "struct",
        fields: [
          { name: "update_count", type: "u32" },
          { name: "min_timestamp", type: "i64" },
          { name: "max_timestamp", type: "i64" }
        ]
      }
    },
    {
      name: "ProofNode",
      type: {
        kind: "struct",
        fields: [
          { name: "hash", type: { array: ["u8", 32] } },
          { name: "is_right_sibling", type: "bool" }
        ]
      }
    }
  ]
} as unknown as Idl;
