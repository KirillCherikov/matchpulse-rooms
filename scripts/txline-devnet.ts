import anchorDefault, * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type Commitment
} from "@solana/web3.js";
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import nacl from "tweetnacl";
import { z } from "zod";
import type { Txoracle } from "../vendor/txline/devnet/types/txoracle.js";
import {
  BROADCAST_CONFIRMATION,
  DURATION_WEEKS,
  SELECTED_LEAGUES,
  SERVICE_LEVEL_ID,
  activationMessagePreimage,
  assertBroadcastAuthorization,
  assertCredentialEnvPath,
  assertFreeTierPricing,
  assertPinnedArtifact,
  assertPinnedIdlContract,
  assertToken2022AssociatedAccountData,
  createAssociatedTokenAccountInstruction,
  deriveAssociatedTokenAddress,
  inspectSubscriptionInstructions,
  integerString,
  maskCredential,
  parseDevnetPin,
  publicTransactionReceipt,
  redactSensitiveText,
  token2022AssociatedAccountLength,
  token2022MintTlvData,
  type SubscriptionAccounts,
  type TxLineDevnetPin
} from "./txline-devnet-helpers.js";
import {
  classifyProofVerification,
  decodeProofHash,
  encodeU16LittleEndian,
  fixtureRootWindowStartDay,
  normalizeProofNodes,
  txlineFixtureValidationSchema
} from "../src/verification/txline-proof.js";

const COMMITMENT: Commitment = "confirmed";
const MAX_HTTP_BODY_BYTES = 5_000_000;
const MAX_SSE_SMOKE_BUFFER_BYTES = 1_000_000;
const DEFAULT_SSE_SMOKE_MS = 15_000;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const pinPath = resolve(repositoryRoot, "vendor/txline/devnet/pin.json");
const execFileAsync = promisify(execFile);

type Pin = TxLineDevnetPin;

const pricingRowSchema = z
  .object({
    rowId: z.unknown(),
    pricePerWeekToken: z.unknown(),
    samplingIntervalSec: z.unknown(),
    leagueBundleId: z.unknown(),
    marketBundleId: z.unknown()
  })
  .passthrough();

const fixtureSchema = z
  .object({
    Ts: z.number().int().nonnegative().safe(),
    StartTime: z.number().int().nonnegative().safe(),
    Competition: z.string(),
    CompetitionId: z.number().int(),
    FixtureGroupId: z.number().int(),
    Participant1Id: z.number().int(),
    Participant1: z.string(),
    Participant2Id: z.number().int(),
    Participant2: z.string(),
    FixtureId: z.number().int().nonnegative().safe(),
    Participant1IsHome: z.boolean()
  })
  .passthrough();

interface PinnedArtifacts {
  pin: Pin;
  idl: Txoracle;
}

interface Credentials {
  jwt: string;
  apiToken: string;
}

interface RequestContext {
  pin: Pin;
  credentials: Credentials;
}

const sensitiveValues = new Set<string>();

const cli = new Command();
cli
  .name("txline-devnet")
  .description("Pinned, simulation-first TxLINE devnet activation and proof tooling")
  .showHelpAfterError();

cli
  .command("preflight")
  .description("Verify pins/program/pricing/accounts/fees and run a signed no-broadcast simulation")
  .requiredOption("--wallet <path>", "Disposable devnet keypair outside this repository")
  .action(async (options: { wallet: string }) => {
    const { pin, idl } = await loadPinnedArtifacts();
    const wallet = await loadDisposableWallet(options.wallet);
    const connection = new Connection(pin.rpcUrl, COMMITMENT);
    const program = createProgram(idl, connection, wallet);
    await assertDevnetProgram(connection, program, pin);
    const pricing = await readFreeTierPricing(program);
    const prepared = await buildAndSimulateSubscription(connection, program, wallet, pin);

    printJson({
      network: "solana-devnet",
      rpcUrl: pin.rpcUrl,
      apiOrigin: pin.apiOrigin,
      sourceCommit: pin.commit,
      idlVersion: pin.idlVersion,
      programId: program.programId.toBase58(),
      walletAddress: wallet.publicKey.toBase58(),
      serviceLevel: pricing,
      ...subscriptionReport(prepared)
    });
  });

cli
  .command("subscribe")
  .description("Build and simulate ATA + free subscribe(1,4); broadcast only with explicit flags")
  .requiredOption("--wallet <path>", "Disposable devnet keypair outside this repository")
  .option("--broadcast", "Broadcast after a fresh successful simulation", false)
  .option("--confirm <phrase>", `Required with --broadcast: ${BROADCAST_CONFIRMATION}`)
  .action(async (options: { wallet: string; broadcast: boolean; confirm?: string }) => {
    assertBroadcastAuthorization(options.broadcast, options.confirm);

    const { pin, idl } = await loadPinnedArtifacts();
    const wallet = await loadDisposableWallet(options.wallet);
    const connection = new Connection(pin.rpcUrl, COMMITMENT);
    const program = createProgram(idl, connection, wallet);
    await assertDevnetProgram(connection, program, pin);
    const pricing = await readFreeTierPricing(program);

    const prepared = await buildAndSimulateSubscription(connection, program, wallet, pin);
    printJson({
      network: "solana-devnet",
      walletAddress: wallet.publicKey.toBase58(),
      serviceLevel: pricing,
      ...subscriptionReport(prepared),
      broadcastRequested: options.broadcast
    });

    if (!options.broadcast) return;

    // Re-read mutable on-chain pricing and re-simulate immediately before broadcast.
    await readFreeTierPricing(program);
    const finalPrepared = await buildAndSimulateSubscription(connection, program, wallet, pin);
    const signature = await connection.sendRawTransaction(finalPrepared.transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: COMMITMENT
    });
    // The public signature is durable recovery evidence if confirmation later
    // times out. Never resend automatically after this point.
    printJson(publicTransactionReceipt(signature, "submitted"));
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: finalPrepared.blockhash,
        lastValidBlockHeight: finalPrepared.lastValidBlockHeight
      },
      "finalized"
    );
    if (confirmation.value.err) {
      throw new Error(`Subscribe transaction failed: ${safeErrorText(confirmation.value.err)}`);
    }
    printJson(publicTransactionReceipt(signature, "finalized"));
  });

cli
  .command("activate")
  .description(
    "Acquire guest JWT, sign exact activation message, activate token, and write ignored env"
  )
  .requiredOption("--wallet <path>", "Disposable devnet keypair outside this repository")
  .requiredOption("--tx-sig <signature>", "Finalized subscribe(1,4) transaction signature")
  .option("--credentials-file <path>", "Ignored credential file", ".env.live.local")
  .action(async (options: { wallet: string; txSig: string; credentialsFile: string }) => {
    const { pin, idl } = await loadPinnedArtifacts();
    const wallet = await loadDisposableWallet(options.wallet);
    const connection = new Connection(pin.rpcUrl, COMMITMENT);
    const program = createProgram(idl, connection, wallet);
    await assertDevnetProgram(connection, program, pin);
    await assertFinalizedSubscribeTransaction(
      connection,
      options.txSig,
      wallet.publicKey,
      program.programId,
      pin
    );

    const jwt = await acquireGuestJwt(pin);
    const message = new TextEncoder().encode(
      activationMessagePreimage(options.txSig, SELECTED_LEAGUES, jwt)
    );
    const walletSignature = Buffer.from(nacl.sign.detached(message, wallet.secretKey)).toString(
      "base64"
    );
    sensitiveValues.add(walletSignature);

    const response = await fetch(`${pin.apiOrigin}/api/token/activate`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        txSig: options.txSig,
        walletSignature,
        leagues: SELECTED_LEAGUES
      })
    });
    if (!response.ok) {
      throw new Error(`TxLINE activation failed with HTTP ${response.status}`);
    }
    const apiToken = await parseActivationToken(response);
    sensitiveValues.add(apiToken);
    await writeCredentialEnv(options.credentialsFile, pin, { jwt, apiToken });
    printJson({
      activated: true,
      network: "devnet",
      apiOrigin: pin.apiOrigin,
      guestJwt: maskCredential(jwt),
      apiToken: maskCredential(apiToken),
      envFile: relative(repositoryRoot, resolve(options.credentialsFile)) || options.credentialsFile
    });
  });

cli
  .command("smoke")
  .description("Run authenticated fixture snapshot and odds/scores SSE connection smoke")
  .option("--credentials-file <path>", "Ignored credential file", ".env.live.local")
  .option(
    "--stream-ms <milliseconds>",
    "Maximum time for each stream",
    String(DEFAULT_SSE_SMOKE_MS)
  )
  .action(async (options: { credentialsFile: string; streamMs: string }) => {
    const { pin } = await loadPinnedArtifacts();
    const credentials = await loadCredentialEnv(options.credentialsFile, pin);
    const streamMs = parseBoundedInteger(options.streamMs, 1_000, 60_000, "stream-ms");
    const context = { pin, credentials };
    const fixtures = await authenticatedJson(
      context,
      "/api/fixtures/snapshot",
      z.array(fixtureSchema)
    );
    const fixture = fixtures[0];
    const [odds, scores] = await Promise.all([
      smokeSse(context, "/api/odds/stream", streamMs),
      smokeSse(context, "/api/scores/stream", streamMs)
    ]);

    printJson({
      authenticated: true,
      fixtureCount: fixtures.length,
      ...(fixture
        ? {
            sampleFixture: {
              fixtureId: fixture.FixtureId,
              participant1: fixture.Participant1,
              participant2: fixture.Participant2,
              sourceTimestamp: new Date(fixture.Ts).toISOString()
            }
          }
        : {}),
      streams: { odds, scores }
    });
  });

cli
  .command("verify-fixture")
  .description(
    "Fetch a real fixture proof and execute validateFixture through read-only view simulation"
  )
  .requiredOption("--wallet <path>", "Disposable devnet keypair outside this repository")
  .option("--credentials-file <path>", "Ignored credential file", ".env.live.local")
  .option("--fixture-id <id>", "Specific observed fixture ID")
  .action(async (options: { wallet: string; credentialsFile: string; fixtureId?: string }) => {
    const { pin, idl } = await loadPinnedArtifacts();
    const credentials = await loadCredentialEnv(options.credentialsFile, pin);
    const wallet = await loadDisposableWallet(options.wallet);
    const connection = new Connection(pin.rpcUrl, COMMITMENT);
    const program = createProgram(idl, connection, wallet);
    await assertDevnetProgram(connection, program, pin);
    const context = { pin, credentials };
    const fixture = await findFixtureForProof(context, options.fixtureId);

    if (!fixture) {
      printJson(
        classifyProofVerification({
          method: "validateFixture",
          checkedAt: new Date().toISOString(),
          proofAvailable: false,
          onChainAttempted: false,
          reason: "No real fixture update was available in the last 12 hours"
        })
      );
      return;
    }

    const proofPath = `/api/fixtures/validation?fixtureId=${fixture.FixtureId}&timestamp=${fixture.Ts}`;
    const validation = await authenticatedJson(context, proofPath, txlineFixtureValidationSchema);
    const windowStartDay = fixtureRootWindowStartDay(validation.snapshot.Ts);
    const [rootAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("ten_daily_fixtures_roots"), Buffer.from(encodeU16LittleEndian(windowStartDay))],
      program.programId
    );
    const snapshot = {
      ts: new anchorDefault.BN(validation.snapshot.Ts),
      startTime: new anchorDefault.BN(validation.snapshot.StartTime),
      competition: validation.snapshot.Competition,
      competitionId: validation.snapshot.CompetitionId,
      fixtureGroupId: validation.snapshot.FixtureGroupId,
      participant1Id: validation.snapshot.Participant1Id,
      participant1: validation.snapshot.Participant1,
      participant2Id: validation.snapshot.Participant2Id,
      participant2: validation.snapshot.Participant2,
      fixtureId: new anchorDefault.BN(validation.snapshot.FixtureId),
      participant1IsHome: validation.snapshot.Participant1IsHome
    };
    const summary = {
      fixtureId: new anchorDefault.BN(validation.summary.fixtureId),
      competitionId: validation.summary.competitionId,
      competition: validation.summary.competition,
      updateStats: {
        updateCount: validation.summary.updateStats.updateCount,
        minTimestamp: new anchorDefault.BN(validation.summary.updateStats.minTimestamp),
        maxTimestamp: new anchorDefault.BN(validation.summary.updateStats.maxTimestamp)
      },
      updateSubTreeRoot: decodeProofHash(validation.summary.updateSubTreeRoot)
    };
    const valid = await program.methods
      .validateFixture(
        snapshot,
        summary,
        normalizeProofNodes(validation.subTreeProof),
        normalizeProofNodes(validation.mainTreeProof)
      )
      .accounts({ tenDailyFixturesRoots: rootAccount })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })])
      .view();

    printJson({
      ...classifyProofVerification({
        method: "validateFixture",
        checkedAt: new Date().toISOString(),
        proofAvailable: true,
        onChainAttempted: true,
        onChainValid: valid,
        ...(!valid ? { reason: "validateFixture returned false" } : {})
      }),
      fixtureId: fixture.FixtureId,
      proofTimestamp: validation.snapshot.Ts,
      rootAccount: rootAccount.toBase58()
    });
  });

await cli.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${safeErrorText(error)}\n`);
  process.exitCode = 1;
});

async function loadPinnedArtifacts(): Promise<PinnedArtifacts> {
  const pin = parseDevnetPin(JSON.parse(await readFile(pinPath, "utf8")));
  const [idlBytes] = await Promise.all([
    readPinnedFile(pin.idl.path, pin.idl.sha256),
    readPinnedFile(pin.generatedTypes.path, pin.generatedTypes.sha256)
  ]);
  const idl = JSON.parse(new TextDecoder().decode(idlBytes)) as Txoracle;
  assertPinnedIdlContract(idl, pin);
  return { pin, idl };
}

async function readPinnedFile(path: string, expectedSha256: string): Promise<Uint8Array> {
  const prefix = "examples/devnet/";
  if (!/^examples\/devnet\/(?:idl|types)\/[A-Za-z0-9._-]+$/.test(path)) {
    throw new Error("Pinned TxLINE artifact is outside the approved devnet directory");
  }
  const localPath = resolve(repositoryRoot, "vendor/txline/devnet", path.slice(prefix.length));
  const bytes = new Uint8Array(await readFile(localPath));
  assertPinnedArtifact(path, bytes, expectedSha256);
  return bytes;
}

async function loadDisposableWallet(walletPath: string): Promise<Keypair> {
  const absolutePath = resolve(walletPath);
  const [walletRealPath, repositoryRealPath, fileStat] = await Promise.all([
    realpath(absolutePath),
    realpath(repositoryRoot),
    stat(absolutePath)
  ]);
  const relativePath = relative(repositoryRealPath, walletRealPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Disposable wallet must be stored outside this repository");
  }
  if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
    throw new Error("Disposable wallet file must be a regular file with mode 0600");
  }
  const secret = z
    .array(z.number().int().min(0).max(255))
    .length(64)
    .parse(JSON.parse(await readFile(walletRealPath, "utf8")));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function createProgram(
  idl: Txoracle,
  connection: Connection,
  payer: Keypair
): anchor.Program<Txoracle> {
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT
  });
  return new anchor.Program<Txoracle>(idl, provider);
}

async function assertDevnetProgram(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  pin: Pin
): Promise<void> {
  if (connection.rpcEndpoint !== pin.rpcUrl || program.programId.toBase58() !== pin.programId) {
    throw new Error("Devnet RPC or TxLINE program ID mismatch");
  }
  const account = await connection.getAccountInfo(program.programId, COMMITMENT);
  if (!account?.executable) throw new Error("Pinned TxLINE devnet program is not executable");
}

async function readFreeTierPricing(
  program: anchor.Program<Txoracle>
): Promise<Record<string, string | number>> {
  const [pricingMatrix] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const matrix = z
    .object({ rows: z.array(pricingRowSchema) })
    .passthrough()
    .parse(await program.account.pricingMatrix.fetch(pricingMatrix));
  const row = matrix.rows.find(
    (candidate) => integerString(candidate.rowId) === String(SERVICE_LEVEL_ID)
  );
  if (!row) throw new Error("TxLINE pricing matrix does not contain service level 1");
  return assertFreeTierPricing(row);
}

function deriveSubscriptionAccounts(
  owner: PublicKey,
  pin: Pin,
  programId: PublicKey
): SubscriptionAccounts {
  const mint = new PublicKey(pin.txlMint);
  const tokenProgram = new PublicKey(pin.tokenPrograms.token2022);
  const associatedTokenProgram = new PublicKey(pin.tokenPrograms.associatedToken);
  const [pricingMatrix] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    programId
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    programId
  );
  return {
    mint,
    tokenProgram,
    associatedTokenProgram,
    pricingMatrix,
    tokenTreasuryPda,
    tokenTreasuryVault: deriveAssociatedTokenAddress(
      mint,
      tokenTreasuryPda,
      true,
      tokenProgram,
      associatedTokenProgram
    ),
    userTokenAccount: deriveAssociatedTokenAddress(
      mint,
      owner,
      false,
      tokenProgram,
      associatedTokenProgram
    )
  };
}

async function buildAndSimulateSubscription(
  connection: Connection,
  program: anchor.Program<Txoracle>,
  wallet: Keypair,
  pin: Pin
) {
  const accounts = deriveSubscriptionAccounts(wallet.publicKey, pin, program.programId);
  const [existingAta, mintAccount, treasuryVault] = await Promise.all([
    connection.getAccountInfo(accounts.userTokenAccount, COMMITMENT),
    connection.getAccountInfo(accounts.mint, COMMITMENT),
    connection.getAccountInfo(accounts.tokenTreasuryVault, COMMITMENT)
  ]);
  if (!mintAccount || !mintAccount.owner.equals(accounts.tokenProgram)) {
    throw new Error("Pinned TxL mint is missing or is not owned by Token-2022");
  }
  const mintTlvData = token2022MintTlvData(Buffer.from(mintAccount.data));
  const tokenAccountLength = token2022AssociatedAccountLength(mintTlvData);
  if (!treasuryVault || !treasuryVault.owner.equals(accounts.tokenProgram)) {
    throw new Error("Pinned TxLINE treasury vault is missing or is not owned by Token-2022");
  }
  assertToken2022AssociatedAccountData(
    Buffer.from(treasuryVault.data),
    accounts.mint,
    accounts.tokenTreasuryPda,
    tokenAccountLength,
    mintTlvData
  );
  if (existingAta) {
    if (!existingAta.owner.equals(accounts.tokenProgram)) {
      throw new Error("Existing TxL associated token account is not owned by Token-2022");
    }
    assertToken2022AssociatedAccountData(
      Buffer.from(existingAta.data),
      accounts.mint,
      wallet.publicKey,
      tokenAccountLength,
      mintTlvData
    );
  }
  const transaction = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: accounts.pricingMatrix,
      tokenMint: accounts.mint,
      userTokenAccount: accounts.userTokenAccount,
      tokenTreasuryVault: accounts.tokenTreasuryVault,
      tokenTreasuryPda: accounts.tokenTreasuryPda,
      tokenProgram: accounts.tokenProgram,
      associatedTokenProgram: accounts.associatedTokenProgram,
      systemProgram: SystemProgram.programId
    })
    .transaction();
  if (!existingAta) {
    transaction.instructions.unshift(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        accounts.userTokenAccount,
        wallet.publicKey,
        accounts.mint,
        accounts.tokenProgram,
        accounts.associatedTokenProgram
      )
    );
  }
  const latest = await connection.getLatestBlockhash(COMMITMENT);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  const instructionSummary = inspectSubscriptionInstructions(
    transaction.instructions,
    wallet.publicKey,
    program.programId,
    accounts
  );
  const message = transaction.compileMessage();
  const signedTransaction = new VersionedTransaction(message);
  signedTransaction.sign([wallet]);
  const fee = await connection.getFeeForMessage(message, COMMITMENT);
  if (fee.value === null) throw new Error("Solana RPC did not return a transaction fee estimate");
  const rent = existingAta
    ? 0
    : await connection.getMinimumBalanceForRentExemption(tokenAccountLength, COMMITMENT);
  const balance = await connection.getBalance(wallet.publicKey, COMMITMENT);
  if (balance < fee.value + rent) {
    throw new Error(
      `Insufficient devnet SOL: need at least ${fee.value + rent} lamports for estimated fee and rent`
    );
  }
  const simulation = await connection.simulateTransaction(signedTransaction, {
    commitment: COMMITMENT,
    sigVerify: true
  });
  if (simulation.value.err) {
    throw new Error(`Subscription simulation failed: ${safeErrorText(simulation.value.err)}`);
  }
  return {
    transaction: signedTransaction,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    accounts,
    walletAddress: wallet.publicKey,
    balanceLamports: balance,
    tokenAccountLength,
    createsUserTokenAccount: existingAta === null,
    estimatedFeeLamports: fee.value,
    estimatedRentLamports: rent,
    instructionSummary,
    unitsConsumed: simulation.value.unitsConsumed ?? null
  };
}

function subscriptionReport(
  prepared: Awaited<ReturnType<typeof buildAndSimulateSubscription>>
): Record<string, unknown> {
  const { accounts } = prepared;
  return {
    simulation: "passed",
    unitsConsumed: prepared.unitsConsumed,
    balanceLamports: prepared.balanceLamports,
    estimatedFeeLamports: prepared.estimatedFeeLamports,
    estimatedRentLamports: prepared.estimatedRentLamports,
    maximumWalletLamportDebit: prepared.estimatedFeeLamports + prepared.estimatedRentLamports,
    tokenAccountLength: prepared.tokenAccountLength,
    exactAccounts: {
      feePayer: prepared.walletAddress.toBase58(),
      txlineProgram: prepared.instructionSummary.at(-1)?.programId,
      pricingMatrix: accounts.pricingMatrix.toBase58(),
      txlMint: accounts.mint.toBase58(),
      userTokenAccount: accounts.userTokenAccount.toBase58(),
      tokenTreasuryVault: accounts.tokenTreasuryVault.toBase58(),
      tokenTreasuryPda: accounts.tokenTreasuryPda.toBase58(),
      token2022Program: accounts.tokenProgram.toBase58(),
      associatedTokenProgram: accounts.associatedTokenProgram.toBase58(),
      systemProgram: SystemProgram.programId.toBase58()
    },
    instructions: prepared.instructionSummary,
    expectedAccountChanges: [
      {
        address: prepared.walletAddress.toBase58(),
        action: "debit-devnet-lamports",
        maximumLamports: prepared.estimatedFeeLamports + prepared.estimatedRentLamports
      },
      {
        address: accounts.userTokenAccount.toBase58(),
        action: prepared.createsUserTokenAccount
          ? "create-token-2022-account"
          : "reuse-validated-account",
        dataLength: prepared.tokenAccountLength,
        rentLamports: prepared.estimatedRentLamports,
        ownerProgram: accounts.tokenProgram.toBase58(),
        txlTokenAmountChange: "0"
      },
      {
        address: accounts.tokenTreasuryVault.toBase58(),
        action: "free-tier-subscribe",
        txlTokenAmountChange: "0"
      }
    ]
  };
}

async function assertFinalizedSubscribeTransaction(
  connection: Connection,
  txSig: string,
  wallet: PublicKey,
  programId: PublicKey,
  pin: Pin
): Promise<void> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(txSig)) {
    throw new Error("Invalid Solana transaction signature format");
  }
  const transaction = await connection.getTransaction(txSig, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0
  });
  if (!transaction || transaction.meta?.err) {
    throw new Error("Subscribe transaction is not finalized successfully on Solana devnet");
  }
  if (transaction.transaction.signatures[0] !== txSig) {
    throw new Error("Subscribe transaction signature does not match the requested receipt");
  }
  const message = transaction.transaction.message;
  if (message.version !== "legacy" || message.addressTableLookups.length !== 0) {
    throw new Error(
      "Subscribe transaction must use the approved legacy message without lookup tables"
    );
  }
  const keys = message.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) {
    throw new Error(
      "Subscribe transaction wallet or TxLINE program does not match activation inputs"
    );
  }
  const instructions = message.compiledInstructions.map((instruction) => {
    const instructionProgram = keys[instruction.programIdIndex];
    if (!instructionProgram) {
      throw new Error("Subscribe transaction contains an invalid program index");
    }
    return new TransactionInstruction({
      programId: instructionProgram,
      keys: instruction.accountKeyIndexes.map((index) => {
        const pubkey = keys[index];
        if (!pubkey) throw new Error("Subscribe transaction contains an invalid account index");
        return {
          pubkey,
          isSigner: message.isAccountSigner(index),
          isWritable: message.isAccountWritable(index)
        };
      }),
      data: Buffer.from(instruction.data)
    });
  });
  const accounts = deriveSubscriptionAccounts(wallet, pin, programId);
  inspectSubscriptionInstructions(instructions, wallet, programId, accounts, false);

  const allowedInnerPrograms = new Set([
    SystemProgram.programId.toBase58(),
    programId.toBase58(),
    accounts.tokenProgram.toBase58(),
    accounts.associatedTokenProgram.toBase58()
  ]);
  for (const inner of transaction.meta?.innerInstructions ?? []) {
    for (const instruction of inner.instructions) {
      const innerProgram = keys[instruction.programIdIndex];
      if (!innerProgram || !allowedInnerPrograms.has(innerProgram.toBase58())) {
        throw new Error("Subscribe transaction invoked an unauthorized inner program");
      }
    }
  }
}

async function acquireGuestJwt(pin: Pin): Promise<string> {
  const response = await fetch(`${pin.apiOrigin}/auth/guest/start`, {
    method: "POST",
    redirect: "error"
  });
  if (!response.ok) throw new Error(`Guest JWT request failed with HTTP ${response.status}`);
  const data = z
    .object({ token: z.string().min(16).max(16_384) })
    .strict()
    .parse(await response.json());
  sensitiveValues.add(data.token);
  return data.token;
}

async function parseActivationToken(response: Response): Promise<string> {
  const body = await readBoundedText(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = z
      .object({ token: z.string().min(8).max(16_384) })
      .strict()
      .parse(JSON.parse(body));
    return data.token;
  }
  return z.string().trim().min(8).max(16_384).parse(body);
}

async function writeCredentialEnv(path: string, pin: Pin, credentials: Credentials): Promise<void> {
  const absolutePath = assertCredentialEnvPath(repositoryRoot, path);
  await assertCredentialPathIsIgnored(absolutePath);
  const parent = dirname(absolutePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await lstat(absolutePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || (existing.mode & 0o777) !== 0o600)) {
    throw new Error("Existing credential env must be a regular file with mode 0600");
  }
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  const content = [
    "TXLINE_NETWORK=devnet",
    `TXLINE_API_ORIGIN=${pin.apiOrigin}`,
    `TXLINE_GUEST_JWT=${quoteEnv(credentials.jwt)}`,
    `TXLINE_API_TOKEN=${quoteEnv(credentials.apiToken)}`,
    "TXLINE_LIVE_ENABLED=true",
    ""
  ].join("\n");
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, absolutePath);
    await chmod(absolutePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function loadCredentialEnv(path: string, pin: Pin): Promise<Credentials> {
  const absolutePath = assertCredentialEnvPath(repositoryRoot, path);
  await assertCredentialPathIsIgnored(absolutePath);
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
    throw new Error("Credential env must be a regular file with mode 0600");
  }
  const file = await readFile(absolutePath, "utf8");
  const values = new Map<string, string>();
  for (const line of file.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value) as string;
    }
    values.set(key, value);
  }
  if (
    values.get("TXLINE_NETWORK") !== "devnet" ||
    values.get("TXLINE_API_ORIGIN") !== pin.apiOrigin ||
    values.get("TXLINE_LIVE_ENABLED") !== "true"
  ) {
    throw new Error("Live credential file is not pinned to the approved TxLINE devnet origin");
  }
  const credentials = {
    jwt: z.string().min(16).max(16_384).parse(values.get("TXLINE_GUEST_JWT")),
    apiToken: z.string().min(8).max(16_384).parse(values.get("TXLINE_API_TOKEN"))
  };
  sensitiveValues.add(credentials.jwt);
  sensitiveValues.add(credentials.apiToken);
  return credentials;
}

async function authenticatedJson<T>(
  context: RequestContext,
  path: string,
  schema: z.ZodType<T>
): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("Refusing a non-API TxLINE request path");
  const response = await fetch(`${context.pin.apiOrigin}${path}`, {
    redirect: "error",
    headers: authenticatedHeaders(context.credentials)
  });
  if (!response.ok)
    throw new Error(`Authenticated TxLINE request failed with HTTP ${response.status}`);
  return schema.parse(JSON.parse(await readBoundedText(response)));
}

function authenticatedHeaders(credentials: Credentials): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.jwt}`,
    "x-api-token": credentials.apiToken
  };
}

async function smokeSse(context: RequestContext, path: string, durationMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), durationMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let opened = false;
  try {
    const response = await fetch(`${context.pin.apiOrigin}${path}`, {
      redirect: "error",
      headers: {
        ...authenticatedHeaders(context.credentials),
        accept: "text/event-stream",
        "cache-control": "no-cache"
      },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`TxLINE SSE request failed with HTTP ${response.status}`);
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      throw new Error("TxLINE SSE response has an incompatible content type");
    }
    opened = true;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const result = await reader.read();
      if (result.done) return { opened, observed: "stream-ended" };
      buffer += decoder.decode(result.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_SMOKE_BUFFER_BYTES) {
        throw new Error("TxLINE SSE event exceeded the configured smoke-test limit");
      }
      const separator = buffer.match(/\r?\n\r?\n/);
      if (separator?.index !== undefined) {
        const block = buffer.slice(0, separator.index);
        const hasData = /^data:/m.test(block);
        const event = /^event:\s*(.+)$/m.exec(block)?.[1] ?? "message";
        const heartbeat =
          event === "heartbeat" || block.split(/\r?\n/).some((line) => line.startsWith(":"));
        const id = /^id:\s*(.+)$/m.exec(block)?.[1];
        return {
          opened,
          observed: heartbeat ? "heartbeat" : event,
          dataObserved: hasData && !heartbeat,
          ...(id ? { lastEventId: id } : {})
        };
      }
    }
  } catch (error) {
    if (opened && isAbortError(error)) return { opened: true, observed: "awaiting-data" };
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

async function findFixtureForProof(
  context: RequestContext,
  requestedFixtureId: string | undefined
): Promise<z.infer<typeof fixtureSchema> | undefined> {
  const requested = requestedFixtureId
    ? parseBoundedInteger(requestedFixtureId, 1, Number.MAX_SAFE_INTEGER, "fixture-id")
    : undefined;
  const now = Date.now();
  for (let offset = 0; offset < 12; offset += 1) {
    const target = new Date(now - offset * 3_600_000);
    const epochDay = Math.floor(target.getTime() / 86_400_000);
    const fixtures = await authenticatedJson(
      context,
      `/api/fixtures/updates/${epochDay}/${target.getUTCHours()}`,
      z.array(fixtureSchema)
    );
    const match = requested
      ? fixtures.find((fixture) => fixture.FixtureId === requested)
      : fixtures[0];
    if (match) return match;
  }
  return undefined;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
    throw new Error("TxLINE response exceeded the configured body limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_HTTP_BODY_BYTES) {
    throw new Error("TxLINE response exceeded the configured body limit");
  }
  return text;
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the permitted range`);
  }
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeErrorText(error: unknown): string {
  return redactSensitiveText(error, sensitiveValues);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function assertCredentialPathIsIgnored(absolutePath: string): Promise<void> {
  const pathFromRepository = relative(repositoryRoot, absolutePath);
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--", pathFromRepository], {
      cwd: repositoryRoot,
      windowsHide: true
    });
  } catch (error) {
    if (isNodeError(error) && String(error.code) === "1") {
      throw new Error("Credential env path is not ignored by Git");
    }
    throw error;
  }
}
