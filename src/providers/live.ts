import { z, type ZodType } from "zod";
import type {
  Fixture,
  LiveConnectionStatus,
  LiveFixtureObservation,
  LiveStreamHealth,
  ProviderMessage
} from "../domain/models.js";
import { parseProviderMessage } from "../domain/schemas.js";
import { SseParser, type ServerSentEvent } from "./sse-parser.js";
import {
  adaptTxLineFixture,
  adaptTxLineScoreEvent,
  epochMillisToIso,
  preserveTxLineOdds,
  scoreRawReference,
  type PreservedTxLineOdds
} from "./txline-adapter.js";
import {
  txLineFixtureArraySchema,
  txLineGuestTokenSchema,
  txLineHeartbeatEnvelopeSchema,
  txLineHeartbeatSchema,
  txLineOddsArraySchema,
  txLineOddsSchema,
  txLineScoreArraySchema,
  txLineScoreSchema,
  type TxLineOddsRecord,
  type TxLineScoreRecord
} from "./txline-schemas.js";
import type { LiveTxLineObserver, LiveTxLineRuntimeProvider, TxLineProvider } from "./types.js";

const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_SSE_EVENT_BYTES = 1_048_576;

type StreamKind = "odds" | "scores";

export interface LiveTxLineProviderOptions {
  enabled: boolean;
  apiOrigin: string;
  guestJwt: string;
  apiToken: string;
  maxRetainedMessages: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxReconnectAttempts: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type RetainedTxLineRecord =
  | {
      feed: "odds";
      record: TxLineOddsRecord;
      sourceTimestamp: string;
      receivedTimestamp: string;
      rawReference: string;
      decimalConversion: "unavailable";
      eventId?: string;
    }
  | {
      feed: "scores";
      record: TxLineScoreRecord;
      sourceTimestamp: string;
      receivedTimestamp: string;
      rawReference: string;
      eventId?: string;
    };

interface RuntimeConfiguration {
  apiOrigin: string;
  apiToken: string;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxReconnectAttempts: number;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface OpenedResponse {
  response: Response;
  controller: AbortController;
  deadlineAt: number;
  cleanup: () => void;
}

/**
 * Official TxLINE OpenAPI 1.5.6 HTTP/SSE transport.
 *
 * The boolean constructor remains available for the isolated domain-ingestion
 * tests. The object constructor activates the authenticated read-only runtime.
 * Official integer `Prices` are retained as received and are never fabricated
 * into Sentinel decimal-odds messages.
 */
export class LiveTxLineProvider implements TxLineProvider, LiveTxLineRuntimeProvider {
  public readonly mode = "live" as const;
  private readonly enabled: boolean;
  private readonly maxRetainedMessages: number;
  private readonly runtime: RuntimeConfiguration | undefined;
  private readonly received: ProviderMessage[] = [];
  private readonly retainedRecords: RetainedTxLineRecord[] = [];
  private readonly seenOddsMessageIds = new Set<string>();
  private readonly seenScoreRecords = new Set<string>();
  private readonly scoreSequenceByConnection = new Map<string, number>();
  private readonly lastEventIds: Partial<Record<StreamKind, string>> = {};
  private readonly healthByStream: Record<StreamKind, LiveStreamHealth> = {
    odds: { status: "disconnected", reconnectAttempt: 0 },
    scores: { status: "disconnected", reconnectAttempt: 0 }
  };
  private readonly secrets = new Set<string>();
  private domainFixtures: Fixture[];
  private officialFixtureObservations: LiveFixtureObservation[] = [];
  private guestJwt: string | undefined;
  private observer: LiveTxLineObserver | undefined;
  private controller: AbortController | undefined;
  private runPromise: Promise<void> | undefined;
  private renewalPromise: Promise<void> | undefined;
  private authenticated = false;
  private aggregateConnectionStatus: LiveConnectionStatus = "disconnected";

  public constructor(options: LiveTxLineProviderOptions);
  public constructor(enabled: boolean, maxRetainedMessages?: number, fixtures?: Fixture[]);
  public constructor(
    optionsOrEnabled: LiveTxLineProviderOptions | boolean,
    maxRetainedMessages = 1_000,
    fixtures: Fixture[] = []
  ) {
    if (typeof optionsOrEnabled === "boolean") {
      this.enabled = optionsOrEnabled;
      this.maxRetainedMessages = positiveInteger(
        maxRetainedMessages,
        "Live message retention limit"
      );
      this.domainFixtures = structuredClone(fixtures);
      return;
    }

    const options = optionsOrEnabled;
    this.enabled = options.enabled;
    this.maxRetainedMessages = positiveInteger(
      options.maxRetainedMessages,
      "Live message retention limit"
    );
    this.domainFixtures = [];
    this.guestJwt = boundedCredential(options.guestJwt, "guest JWT");
    const apiToken = boundedCredential(options.apiToken, "API token");
    this.secrets.add(this.guestJwt);
    this.secrets.add(apiToken);
    this.runtime = {
      apiOrigin: validatedApiOrigin(options.apiOrigin),
      apiToken,
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, "Request timeout"),
      idleTimeoutMs: positiveInteger(options.idleTimeoutMs, "Stream idle timeout"),
      retryInitialDelayMs: positiveInteger(options.retryInitialDelayMs, "Initial retry delay"),
      retryMaxDelayMs: positiveInteger(options.retryMaxDelayMs, "Maximum retry delay"),
      maxReconnectAttempts: nonnegativeInteger(
        options.maxReconnectAttempts,
        "Maximum reconnect attempts"
      ),
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: options.now ?? (() => new Date()),
      sleep: options.sleep ?? abortableDelay
    };
    if (this.runtime.retryMaxDelayMs < this.runtime.retryInitialDelayMs) {
      throw new Error("Maximum retry delay must be at least the initial retry delay");
    }
  }

  public fixtures(): Fixture[] {
    return structuredClone(this.domainFixtures);
  }

  public observedFixtures(): LiveFixtureObservation[] {
    return structuredClone(this.officialFixtureObservations);
  }

  public readiness(): { ready: boolean; reason?: string } {
    if (!this.enabled) {
      return {
        ready: false,
        reason: "Live mode requires documented TxLINE credentials and transport."
      };
    }
    if (!this.runtime) {
      return { ready: false, reason: "Official TxLINE transport adapter is not configured." };
    }
    return this.authenticated
      ? { ready: true }
      : { ready: false, reason: "TxLINE transport has not authenticated successfully." };
  }

  public ingest(rawPayload: unknown): ProviderMessage {
    const message = this.validate(rawPayload);
    this.retain(message);
    return structuredClone(message);
  }

  public validate(rawPayload: unknown): ProviderMessage {
    return parseProviderMessage(rawPayload);
  }

  public retain(message: ProviderMessage): void {
    const validated = parseProviderMessage(message);
    this.received.push(validated);
    trimToLimit(this.received, this.maxRetainedMessages);
  }

  public receivedMessages(): ProviderMessage[] {
    return structuredClone(this.received);
  }

  public receivedOfficialRecords(): RetainedTxLineRecord[] {
    return structuredClone(this.retainedRecords);
  }

  public async start(observer: LiveTxLineObserver): Promise<void> {
    if (this.runPromise) return this.runPromise;
    if (!this.enabled || !this.runtime || !this.guestJwt) {
      throw new Error("Official TxLINE transport adapter is not configured.");
    }
    this.observer = observer;
    this.controller = new AbortController();
    this.runPromise = this.run(observer, this.controller.signal);
    return this.runPromise;
  }

  public async stop(): Promise<void> {
    const observer = this.observer;
    this.controller?.abort();
    await this.runPromise?.catch(() => undefined);
    this.authenticated = false;
    if (observer) {
      this.emitHealth("odds", { status: "stopped", reconnectAttempt: 0 });
      this.emitHealth("scores", { status: "stopped", reconnectAttempt: 0 });
      observer.onAuthenticated(false);
    }
    this.observer = undefined;
    this.controller = undefined;
    this.runPromise = undefined;
    this.renewalPromise = undefined;
  }

  private async run(observer: LiveTxLineObserver, signal: AbortSignal): Promise<void> {
    this.emitConnectionStatus("connecting");
    try {
      await this.bootstrapWithRetry(signal);
      if (signal.aborted) return;
      this.emitHealth("odds", { status: "connecting", reconnectAttempt: 0 });
      this.emitHealth("scores", { status: "connecting", reconnectAttempt: 0 });
      await Promise.all([this.runStream("odds", signal), this.runStream("scores", signal)]);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      const diagnostic = this.safeDiagnostic(error);
      this.controller?.abort();
      this.authenticated = false;
      observer.onAuthenticated(false);
      this.emitConnectionStatus("disconnected", diagnostic);
      throw new Error(diagnostic);
    }
  }

  private async bootstrapWithRetry(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.bootstrap();
        return;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        if (error instanceof TxLineHttpStatusError && error.status === 403) throw error;
        const diagnostic = this.safeDiagnostic(error);
        if (failures >= this.requireRuntime().maxReconnectAttempts) {
          throw new Error(diagnostic);
        }
        failures += 1;
        this.emitConnectionStatus("reconnecting", diagnostic);
        await this.requireRuntime().sleep(this.retryDelay(failures), signal);
      }
    }
    throw abortError();
  }

  private async bootstrap(): Promise<void> {
    const fixtures = await this.getJson("/api/fixtures/snapshot", txLineFixtureArraySchema);
    const receivedAt = this.nowIso();
    const adapted = fixtures.map((record) => ({
      record,
      adapted: adaptTxLineFixture(record, receivedAt)
    }));
    const newestFirst = adapted.toSorted((left, right) =>
      right.record.Ts === left.record.Ts ? 0 : right.record.Ts > left.record.Ts ? 1 : -1
    );
    const latest = newestFirst[0];
    if (!latest) {
      this.officialFixtureObservations = [];
      return;
    }

    const fixtureId = latest.record.FixtureId;
    let odds = await this.getJson(`/api/odds/snapshot/${fixtureId}`, txLineOddsArraySchema);
    this.assertFixtureRecords(odds, fixtureId, "FixtureId", "odds snapshot");
    if (odds.length === 0 && this.isHistoricalFallbackEligible(latest.record.StartTime)) {
      odds = await this.getJson(
        historicalOddsBucketPath(latest.record.StartTime, fixtureId),
        txLineOddsArraySchema
      );
      this.assertFixtureRecords(odds, fixtureId, "FixtureId", "historical odds bucket");
    }
    let scores = await this.getJson(`/api/scores/snapshot/${fixtureId}`, txLineScoreArraySchema);
    this.assertFixtureRecords(scores, fixtureId, "fixtureId", "scores snapshot");
    if (scores.length === 0 && this.isHistoricalFallbackEligible(latest.record.StartTime)) {
      scores = await this.getJson(`/api/scores/historical/${fixtureId}`, txLineScoreArraySchema);
      this.assertFixtureRecords(scores, fixtureId, "fixtureId", "historical scores");
    }

    // Publish the bootstrap atomically only after every response has passed the
    // official schema and same-fixture checks. A retry must not expose a
    // half-populated live view from a failed attempt.
    this.officialFixtureObservations = newestFirst
      .slice(0, this.maxRetainedMessages)
      .map(({ adapted: value }) => value.fixture);
    this.observer?.onFixture(latest.adapted.fixture);
    for (const record of odds.toSorted((left, right) => compareInteger(left.Ts, right.Ts))) {
      this.observeOddsRecord(record, this.nowIso());
    }
    for (const record of scores.toSorted((left, right) => compareInteger(left.ts, right.ts))) {
      this.observeScoreRecord(record, this.nowIso());
    }
  }

  private async runStream(stream: StreamKind, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.emitHealth(stream, {
        status: failures === 0 ? "connecting" : "reconnecting",
        reconnectAttempt: failures
      });
      try {
        const activity = await this.consumeStream(stream);
        if (signal.aborted) return;
        failures = activity ? 0 : failures;
        throw new Error(`TxLINE ${stream} stream ended unexpectedly`);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        const diagnostic = this.safeDiagnostic(error);
        if (error instanceof TxLineHttpStatusError && error.status === 403) {
          this.authenticated = false;
          this.observer?.onAuthenticated(false);
          this.emitHealth(stream, {
            status: "disconnected",
            reconnectAttempt: failures,
            error: diagnostic
          });
          throw error;
        }
        if (failures >= this.requireRuntime().maxReconnectAttempts) {
          this.emitHealth(stream, {
            status: "disconnected",
            reconnectAttempt: failures,
            error: diagnostic
          });
          throw new Error(diagnostic);
        }
        failures += 1;
        this.emitHealth(stream, {
          status: "reconnecting",
          reconnectAttempt: failures,
          error: diagnostic
        });
        await this.requireRuntime().sleep(this.retryDelay(failures), signal);
      }
    }
  }

  private async consumeStream(stream: StreamKind): Promise<boolean> {
    const path = stream === "odds" ? "/api/odds/stream" : "/api/scores/stream";
    const lastEventId = this.lastEventIds[stream];
    const opened = await this.openAuthenticated(path, {
      accept: "text/event-stream",
      "cache-control": "no-cache",
      ...(lastEventId ? { "last-event-id": lastEventId } : {})
    });
    const contentType = opened.response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType?.toLowerCase() !== "text/event-stream" || !opened.response.body) {
      await this.dispose(opened);
      throw new Error(`TxLINE ${stream} stream returned an invalid content type or empty body`);
    }

    this.emitHealth(stream, { status: "connected", reconnectAttempt: 0 });
    const reader = opened.response.body.getReader();
    const parser = new SseParser({ maxEventBytes: MAX_SSE_EVENT_BYTES });
    let activity = false;
    let activityDeadlineAt = Date.now() + this.requireRuntime().idleTimeoutMs;
    try {
      while (true) {
        const result = await readWithDeadline(
          reader,
          activityDeadlineAt,
          opened.controller,
          `TxLINE ${stream} stream exceeded its idle timeout`
        );
        if (result.done) {
          for (const event of parser.finish()) {
            const observed = this.observeSseEvent(stream, event);
            activity = observed || activity;
            if (observed) activityDeadlineAt = Date.now() + this.requireRuntime().idleTimeoutMs;
          }
          return activity;
        }
        for (const event of parser.push(result.value)) {
          const observed = this.observeSseEvent(stream, event);
          activity = observed || activity;
          if (observed) activityDeadlineAt = Date.now() + this.requireRuntime().idleTimeoutMs;
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
      opened.cleanup();
      opened.controller.abort();
    }
  }

  private observeSseEvent(stream: StreamKind, event: ServerSentEvent): boolean {
    if (event.event === "heartbeat") {
      txLineHeartbeatEnvelopeSchema.parse(event);
      if (event.data.trim() !== "") {
        txLineHeartbeatSchema.parse(parseJson(event.data, `${stream} heartbeat`));
      }
      this.emitHealth(stream, {
        status: "connected",
        reconnectAttempt: 0,
        lastHeartbeatAt: this.nowIso()
      });
      return true;
    }
    if (event.comments.length > 0 && event.data.trim() === "") return false;
    if (event.event !== undefined && event.event !== "message") {
      throw new Error(`TxLINE ${stream} stream returned unsupported event type`);
    }
    if (!event.id) throw new Error(`TxLINE ${stream} data event did not include an event ID`);
    const ordering = compareEventIds(event.id, this.lastEventIds[stream]);
    const receivedAt = this.nowIso();
    const payload = parseJson(event.data, `${stream} data event`);
    const parsed =
      stream === "odds" ? txLineOddsSchema.parse(payload) : txLineScoreSchema.parse(payload);
    if (ordering <= 0) return true;

    if (stream === "odds") {
      this.observeOddsRecord(parsed as TxLineOddsRecord, receivedAt, event.id);
    } else {
      this.observeScoreRecord(parsed as TxLineScoreRecord, receivedAt, event.id);
    }
    this.lastEventIds[stream] = event.id;
    this.emitHealth(stream, {
      status: "connected",
      reconnectAttempt: 0,
      lastEventAt: receivedAt
    });
    return true;
  }

  private observeOddsRecord(
    record: TxLineOddsRecord,
    receivedTimestamp: string,
    eventId?: string
  ): void {
    if (this.seenOddsMessageIds.has(record.MessageId)) return;
    rememberBounded(this.seenOddsMessageIds, record.MessageId, this.maxRetainedMessages);
    const preserved: PreservedTxLineOdds = preserveTxLineOdds(record, receivedTimestamp);
    this.retainOfficialRecord({
      feed: "odds",
      record: preserved.record,
      sourceTimestamp: preserved.sourceTimestamp,
      receivedTimestamp: preserved.receivedTimestamp,
      rawReference: preserved.rawReference,
      decimalConversion: preserved.decimalConversion,
      ...(eventId ? { eventId } : {})
    });
    this.observer?.onOddsTimestamp(preserved.sourceTimestamp);
  }

  private observeScoreRecord(
    record: TxLineScoreRecord,
    receivedTimestamp: string,
    eventId?: string
  ): void {
    const recordKey = `${record.fixtureId}:${record.connectionId}:${record.seq}:${record.id}`;
    if (this.seenScoreRecords.has(recordKey)) return;
    const connectionKey = `${record.fixtureId}:${record.connectionId}`;
    const previousSequence = this.scoreSequenceByConnection.get(connectionKey);
    if (previousSequence !== undefined && record.seq <= previousSequence) return;
    rememberBounded(this.seenScoreRecords, recordKey, this.maxRetainedMessages);
    rememberSequence(
      this.scoreSequenceByConnection,
      connectionKey,
      record.seq,
      this.maxRetainedMessages
    );

    const sourceTimestamp = epochMillisToIso(record.ts);
    this.retainOfficialRecord({
      feed: "scores",
      record: structuredClone(record),
      sourceTimestamp,
      receivedTimestamp,
      rawReference: scoreRawReference(record),
      ...(eventId ? { eventId } : {})
    });
    this.observer?.onScoreTimestamp(sourceTimestamp);
    const normalized = adaptTxLineScoreEvent(record, receivedTimestamp);
    if (!normalized) return;
    this.retain(normalized);
    this.observer?.onProviderMessage?.(structuredClone(normalized));
  }

  private retainOfficialRecord(record: RetainedTxLineRecord): void {
    this.retainedRecords.push(structuredClone(record));
    trimToLimit(this.retainedRecords, this.maxRetainedMessages);
  }

  private async getJson<T>(path: string, schema: ZodType<T>): Promise<T> {
    const opened = await this.openAuthenticated(path, { accept: "application/json" });
    try {
      const contentType = opened.response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new Error(`TxLINE ${path} returned a non-JSON response`);
      }
      const text = await readBoundedText(opened.response, opened.controller, opened.deadlineAt);
      return schema.parse(parseJson(text, path));
    } finally {
      opened.cleanup();
      opened.controller.abort();
    }
  }

  private async openAuthenticated(
    path: string,
    headers: Record<string, string>
  ): Promise<OpenedResponse> {
    const jwtUsed = this.requireGuestJwt();
    let opened = await this.open(path, {
      ...headers,
      authorization: `Bearer ${jwtUsed}`,
      "x-api-token": this.requireRuntime().apiToken
    });
    if (opened.response.status === 401) {
      await this.dispose(opened);
      this.authenticated = false;
      this.observer?.onAuthenticated(false);
      if (this.guestJwt === jwtUsed) await this.renewGuestJwt();
      opened = await this.open(path, {
        ...headers,
        authorization: `Bearer ${this.requireGuestJwt()}`,
        "x-api-token": this.requireRuntime().apiToken
      });
    }
    if (!opened.response.ok) {
      const status = opened.response.status;
      await this.dispose(opened);
      throw new TxLineHttpStatusError(path, status);
    }
    this.authenticated = true;
    this.observer?.onAuthenticated(true);
    return opened;
  }

  private async renewGuestJwt(): Promise<void> {
    if (this.renewalPromise) return this.renewalPromise;
    const renewal = this.performGuestJwtRenewal();
    this.renewalPromise = renewal;
    try {
      await renewal;
    } finally {
      if (this.renewalPromise === renewal) this.renewalPromise = undefined;
    }
  }

  private async performGuestJwtRenewal(): Promise<void> {
    const opened = await this.open("/auth/guest/start", { accept: "application/json" }, "POST");
    try {
      if (!opened.response.ok) {
        throw new Error(`TxLINE guest JWT renewal failed with HTTP ${opened.response.status}`);
      }
      const text = await readBoundedText(opened.response, opened.controller, opened.deadlineAt);
      const result = txLineGuestTokenSchema.parse(parseJson(text, "guest JWT renewal"));
      this.guestJwt = boundedCredential(result.token, "renewed guest JWT");
      this.secrets.add(this.guestJwt);
    } finally {
      opened.cleanup();
      opened.controller.abort();
    }
  }

  private async open(
    path: string,
    headers: Record<string, string>,
    method = "GET"
  ): Promise<OpenedResponse> {
    const runtime = this.requireRuntime();
    const rootSignal = this.controller?.signal;
    if (!rootSignal || rootSignal.aborted) throw abortError();
    if (!path.startsWith("/api/") && path !== "/auth/guest/start") {
      throw new Error("Refusing an undocumented TxLINE request path");
    }
    const url = new URL(path, runtime.apiOrigin);
    if (url.origin !== runtime.apiOrigin) throw new Error("Refusing cross-origin TxLINE request");

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    rootSignal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const deadlineAt = Date.now() + runtime.requestTimeoutMs;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, deadlineAt - Date.now())
    );
    try {
      const response = await runtime.fetch(url.toString(), {
        method,
        headers,
        redirect: "error",
        signal: controller.signal
      });
      clearTimeout(timeout);
      return {
        response,
        controller,
        deadlineAt,
        cleanup: () => rootSignal.removeEventListener("abort", onAbort)
      };
    } catch (error) {
      clearTimeout(timeout);
      rootSignal.removeEventListener("abort", onAbort);
      if (rootSignal.aborted) throw abortError();
      if (timedOut) throw new Error(`TxLINE request ${path} timed out`);
      throw new Error(`TxLINE request ${path} failed: ${this.safeDiagnostic(error)}`);
    }
  }

  private async dispose(opened: OpenedResponse): Promise<void> {
    opened.cleanup();
    opened.controller.abort();
    await opened.response.body?.cancel().catch(() => undefined);
  }

  private emitHealth(stream: StreamKind, patch: LiveStreamHealth): void {
    const previous = this.healthByStream[stream];
    const next: LiveStreamHealth = {
      status: patch.status,
      reconnectAttempt: patch.reconnectAttempt,
      ...(patch.lastHeartbeatAt || previous.lastHeartbeatAt
        ? { lastHeartbeatAt: patch.lastHeartbeatAt ?? previous.lastHeartbeatAt! }
        : {}),
      ...(patch.lastEventAt || previous.lastEventAt
        ? { lastEventAt: patch.lastEventAt ?? previous.lastEventAt! }
        : {}),
      ...(patch.error ? { error: this.safeDiagnostic(patch.error) } : {})
    };
    this.healthByStream[stream] = next;
    this.observer?.onStreamHealth(stream, structuredClone(next));
    this.emitAggregateConnectionStatus();
  }

  private emitAggregateConnectionStatus(): void {
    const statuses = Object.values(this.healthByStream).map((health) => health.status);
    const status: LiveConnectionStatus = statuses.every((value) => value === "connected")
      ? "connected"
      : statuses.some((value) => value === "reconnecting")
        ? "reconnecting"
        : statuses.some((value) => value === "connecting")
          ? "connecting"
          : statuses.every((value) => value === "stopped")
            ? "stopped"
            : "disconnected";
    this.emitConnectionStatus(status);
  }

  private emitConnectionStatus(status: LiveConnectionStatus, error?: string): void {
    const diagnostic = error ? this.safeDiagnostic(error) : undefined;
    if (status === this.aggregateConnectionStatus && !diagnostic) return;
    this.aggregateConnectionStatus = status;
    this.observer?.onConnectionStatus(status, diagnostic);
  }

  private isHistoricalFallbackEligible(startTime: number): boolean {
    const ageMs = this.requireRuntime().now().getTime() - startTime;
    return ageMs >= 6 * 60 * 60 * 1_000 && ageMs <= 14 * 24 * 60 * 60 * 1_000;
  }

  private assertFixtureRecords<T extends Record<K, number>, K extends "FixtureId" | "fixtureId">(
    records: T[],
    fixtureId: number,
    key: K,
    context: string
  ): void {
    if (records.some((record) => record[key] !== fixtureId)) {
      throw new Error(`TxLINE ${context} returned a record for a different fixture`);
    }
  }

  private retryDelay(attempt: number): number {
    const runtime = this.requireRuntime();
    const exponent = Math.min(30, Math.max(0, attempt - 1));
    return Math.min(runtime.retryInitialDelayMs * 2 ** exponent, runtime.retryMaxDelayMs);
  }

  private nowIso(): string {
    const value = this.requireRuntime().now();
    if (!Number.isFinite(value.getTime())) throw new Error("Live clock returned an invalid date");
    return value.toISOString();
  }

  private requireRuntime(): RuntimeConfiguration {
    if (!this.runtime) throw new Error("Official TxLINE transport adapter is not configured.");
    return this.runtime;
  }

  private requireGuestJwt(): string {
    if (!this.guestJwt) throw new Error("TxLINE guest JWT is unavailable");
    return this.guestJwt;
  }

  private safeDiagnostic(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.secrets) {
      if (secret) message = message.replaceAll(secret, "[REDACTED]");
    }
    return message
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/(?:txoracle_api_|api[_-]?token=)[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 240);
  }
}

function compareInteger(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

class TxLineHttpStatusError extends Error {
  public constructor(
    path: string,
    public readonly status: number
  ) {
    super(`Authenticated TxLINE request ${path} failed with HTTP ${status}`);
    this.name = "TxLineHttpStatusError";
  }
}

export function historicalOddsBucketPath(timestamp: number, fixtureId: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("Historical odds timestamp must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(fixtureId) || fixtureId < 0) {
    throw new Error("Historical odds fixture ID must be a nonnegative safe integer");
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Historical odds timestamp is outside the supported date range");
  }
  const epochDay = Math.floor(timestamp / 86_400_000);
  const hourOfDay = date.getUTCHours();
  const interval = Math.floor(date.getUTCMinutes() / 5);
  return `/api/odds/updates/${epochDay}/${hourOfDay}/${interval}?fixtureId=${fixtureId}`;
}

function validatedApiOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("TxLINE API origin must be a credential-free HTTPS origin");
  }
  return parsed.origin;
}

function boundedCredential(value: string, label: string): string {
  return z
    .string()
    .min(1)
    .max(16_384)
    .parse(value, { path: [label] });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function trimToLimit<T>(values: T[], limit: number): void {
  if (values.length > limit) values.splice(0, values.length - limit);
}

function rememberBounded(values: Set<string>, value: string, limit: number): void {
  values.add(value);
  if (values.size <= limit) return;
  const oldest = values.values().next().value;
  if (oldest !== undefined) values.delete(oldest);
}

function rememberSequence(
  values: Map<string, number>,
  key: string,
  sequence: number,
  limit: number
): void {
  values.delete(key);
  values.set(key, sequence);
  if (values.size <= limit) return;
  const oldest = values.keys().next().value;
  if (oldest !== undefined) values.delete(oldest);
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`TxLINE ${context} contained invalid JSON`);
  }
}

function compareEventIds(current: string, previous: string | undefined): number {
  const currentParts = parseEventId(current);
  if (!previous) return 1;
  const previousParts = parseEventId(previous);
  if (currentParts[0] !== previousParts[0]) {
    return currentParts[0] > previousParts[0] ? 1 : -1;
  }
  if (currentParts[1] === previousParts[1]) return 0;
  return currentParts[1] > previousParts[1] ? 1 : -1;
}

function parseEventId(value: string): readonly [bigint, bigint] {
  if (value.length > 128 || !/^\d+:\d+$/.test(value)) {
    throw new Error("TxLINE SSE event ID did not match timestamp:index");
  }
  const [timestamp, index] = value.split(":");
  return [BigInt(timestamp!), BigInt(index!)];
}

async function readBoundedText(
  response: Response,
  controller: AbortController,
  deadlineAt: number
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("TxLINE response exceeded the configured body limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await readWithDeadline(
        reader,
        deadlineAt,
        controller,
        "TxLINE response body timed out"
      );
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("TxLINE response exceeded the configured body limit");
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineAt: number,
  controller: AbortController,
  timeoutMessage: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    controller.abort();
    return Promise.reject(new Error(timeoutMessage));
  }
  return readWithTimeout(reader, remainingMs, controller, timeoutMessage);
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
  timeoutMessage: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (controller.signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timeout = setTimeout(() => {
      finish(() => {
        controller.abort();
        reject(new Error(timeoutMessage));
      });
    }, timeoutMs);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
