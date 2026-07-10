import type {
  AlertSeverity,
  AlertType,
  FeedKind,
  FeedHealthState,
  FeedHealthSummary,
  OperationalAlert,
  ProviderMessage
} from "../domain/models.js";

interface FeedState {
  fixtureId: string;
  feed: FeedKind;
  lastSequence?: number;
  lastReceivedAt?: number;
  lastSourceAt?: number;
  stale: boolean;
  seenIds: Set<string>;
}

export interface DataQualityThresholds {
  staleOddsMs: number;
  staleScoreMs: number;
  delayedUpdateMs: number;
  seenIdLimitPerFeed: number;
}

export interface QualityInspection {
  alerts: OperationalAlert[];
  shouldProcess: boolean;
}

const MAX_INSPECTION_ALERTS_PER_MESSAGE = 3;

export class DataQualitySentinel {
  private readonly feeds = new Map<string, FeedState>();
  private readonly reportedIssues = new Set<string>();
  private alertSequence = 0;

  public constructor(private readonly thresholds: DataQualityThresholds) {}

  public reset(): void {
    this.feeds.clear();
    this.reportedIssues.clear();
    this.alertSequence = 0;
  }

  public inspect(message: ProviderMessage): QualityInspection {
    const feed = message.kind;
    const key = this.feedKey(message.fixtureId, feed);
    const state = this.feeds.get(key) ?? {
      fixtureId: message.fixtureId,
      feed,
      stale: false,
      seenIds: new Set<string>()
    };
    const alerts: OperationalAlert[] = [];
    const receivedAt = new Date(message.receivedTimestamp).getTime();
    const sourceAt = new Date(message.sourceTimestamp).getTime();
    let sequenceGapFrom: number | undefined;

    if (!Number.isFinite(receivedAt) || !Number.isFinite(sourceAt) || receivedAt < sourceAt) {
      this.rememberId(state, message.id);
      this.feeds.set(key, state);
      const issueKey = `invalid-timestamp:${key}:${message.id}`;
      return {
        alerts: this.shouldReport(issueKey)
          ? [
              this.createAlert(
                "invalid_timestamp",
                "critical",
                message.fixtureId,
                feed,
                message.receivedTimestamp,
                `Invalid ${feed} timestamps caused update ${message.id} to be ignored.`,
                {
                  updateId: message.id,
                  sourceTimestamp: message.sourceTimestamp,
                  receivedTimestamp: message.receivedTimestamp
                }
              )
            ]
          : [],
        shouldProcess: false
      };
    }

    if (state.seenIds.has(message.id)) {
      const issueKey = `duplicate-id:${key}:${message.id}`;
      if (this.shouldReport(issueKey)) {
        alerts.push(
          this.createAlert(
            "duplicate_update",
            "warning",
            message.fixtureId,
            feed,
            message.receivedTimestamp,
            `Duplicate ${feed} update ${message.id} was ignored.`,
            { sequence: message.sequence, updateId: message.id, duplicateKind: "id" }
          )
        );
      }
      return { alerts, shouldProcess: false };
    }

    if (state.lastSequence !== undefined) {
      if (message.sequence === state.lastSequence) {
        this.rememberId(state, message.id);
        const issueKey = `duplicate-sequence:${key}:${message.sequence}`;
        if (this.shouldReport(issueKey)) {
          alerts.push(
            this.createAlert(
              "duplicate_update",
              "warning",
              message.fixtureId,
              feed,
              message.receivedTimestamp,
              `Duplicate ${feed} sequence ${message.sequence} was ignored.`,
              { sequence: message.sequence, updateId: message.id, duplicateKind: "sequence" }
            )
          );
        }
        this.feeds.set(key, state);
        return { alerts, shouldProcess: false };
      }
      if (message.sequence < state.lastSequence) {
        this.rememberId(state, message.id);
        const issueKey = `out-of-order-sequence:${key}:${message.id}`;
        if (this.shouldReport(issueKey)) {
          alerts.push(
            this.createAlert(
              "out_of_order_update",
              "warning",
              message.fixtureId,
              feed,
              message.receivedTimestamp,
              `Out-of-order ${feed} sequence ${message.sequence} was ignored after ${state.lastSequence}.`,
              { previousSequence: state.lastSequence, sequence: message.sequence }
            )
          );
        }
        this.feeds.set(key, state);
        return { alerts, shouldProcess: false };
      }
      if (message.sequence > state.lastSequence + 1) {
        sequenceGapFrom = state.lastSequence;
      }
    }

    if (
      (state.lastReceivedAt !== undefined && receivedAt < state.lastReceivedAt) ||
      (state.lastSourceAt !== undefined && sourceAt < state.lastSourceAt)
    ) {
      this.rememberId(state, message.id);
      const issueKey = `out-of-order-time:${key}:${message.id}`;
      if (this.shouldReport(issueKey)) {
        alerts.push(
          this.createAlert(
            "out_of_order_update",
            "warning",
            message.fixtureId,
            feed,
            message.receivedTimestamp,
            `Out-of-order ${feed} timestamp was ignored for update ${message.id}.`,
            { sequence: message.sequence, updateId: message.id }
          )
        );
      }
      this.feeds.set(key, state);
      return { alerts, shouldProcess: false };
    }

    if (feed === "odds" && state.lastReceivedAt === receivedAt && state.lastSourceAt === sourceAt) {
      this.rememberId(state, message.id);
      const issueKey = `non-advancing-time:${key}:${message.id}`;
      if (this.shouldReport(issueKey)) {
        alerts.push(
          this.createAlert(
            "invalid_timestamp",
            "critical",
            message.fixtureId,
            feed,
            message.receivedTimestamp,
            `Non-advancing ${feed} timestamps caused update ${message.id} to be ignored.`,
            { sequence: message.sequence, updateId: message.id }
          )
        );
      }
      this.feeds.set(key, state);
      return { alerts, shouldProcess: false };
    }

    if (sequenceGapFrom !== undefined) {
      alerts.push(
        this.createAlert(
          "sequence_gap",
          "warning",
          message.fixtureId,
          feed,
          message.receivedTimestamp,
          `A ${feed} sequence gap was detected between ${sequenceGapFrom} and ${message.sequence}.`,
          { previousSequence: sequenceGapFrom, sequence: message.sequence }
        )
      );
    }

    const latencyMs = receivedAt - sourceAt;
    if (latencyMs > this.thresholds.delayedUpdateMs) {
      const issueKey = `delayed:${key}`;
      if (this.shouldReport(issueKey)) {
        alerts.push(
          this.createAlert(
            "delayed_update",
            "warning",
            message.fixtureId,
            feed,
            message.receivedTimestamp,
            `${feed} update latency of ${latencyMs}ms exceeded the configured limit.`,
            { latencyMs, thresholdMs: this.thresholds.delayedUpdateMs }
          )
        );
      }
    } else {
      this.reportedIssues.delete(`delayed:${key}`);
    }

    if (state.stale) {
      state.stale = false;
      alerts.push(
        this.createAlert(
          "feed_recovery",
          "info",
          message.fixtureId,
          feed,
          message.receivedTimestamp,
          `${feed} feed recovered after a stale interval.`,
          { sequence: message.sequence }
        )
      );
    }

    state.lastSequence = message.sequence;
    state.lastReceivedAt = receivedAt;
    state.lastSourceAt = sourceAt;
    this.rememberId(state, message.id);
    this.feeds.set(key, state);
    return { alerts, shouldProcess: true };
  }

  public checkStaleness(now: string): OperationalAlert[] {
    const alerts: OperationalAlert[] = [];
    const nowMs = new Date(now).getTime();
    for (const state of this.feeds.values()) {
      if (state.lastReceivedAt === undefined || state.stale) {
        continue;
      }
      const { fixtureId, feed } = state;
      const thresholdMs =
        feed === "odds" ? this.thresholds.staleOddsMs : this.thresholds.staleScoreMs;
      const ageMs = nowMs - state.lastReceivedAt;
      if (ageMs > thresholdMs) {
        state.stale = true;
        alerts.push(
          this.createAlert(
            "stale_feed",
            "critical",
            fixtureId,
            feed,
            now,
            `${feed} feed has been silent for ${ageMs}ms.`,
            { ageMs, thresholdMs }
          )
        );
      }
    }
    return alerts;
  }

  /**
   * Conservative audit preflight bound for one message: every tracked feed can
   * become stale, while inspection can emit a sequence gap, delayed update,
   * and recovery together.
   */
  public maximumAlertsForNextMessage(): number {
    return this.feeds.size + MAX_INSPECTION_ALERTS_PER_MESSAGE;
  }

  public hasStaleFeed(fixtureId: string): boolean {
    return [...this.feeds.values()].some((state) => state.fixtureId === fixtureId && state.stale);
  }

  public feedHealth(fixtureId: string, now: string): FeedHealthSummary {
    const nowMs = new Date(now).getTime();
    const odds = this.feedHealthFor(fixtureId, "odds", nowMs);
    const score = this.feedHealthFor(fixtureId, "score", nowMs);
    const status =
      odds.status === "stale" || score.status === "stale"
        ? "degraded"
        : odds.status === "unknown" || score.status === "unknown"
          ? "unknown"
          : "healthy";
    return { status, odds, score };
  }

  private feedKey(fixtureId: string, feed: FeedKind): string {
    return `feed:${fixtureId}:${feed}`;
  }

  private feedHealthFor(fixtureId: string, feed: FeedKind, nowMs: number): FeedHealthState {
    const state = this.feeds.get(this.feedKey(fixtureId, feed));
    if (!state || state.lastReceivedAt === undefined) {
      return { status: "unknown" };
    }
    const ageMs = Math.max(0, nowMs - state.lastReceivedAt);
    const thresholdMs =
      feed === "odds" ? this.thresholds.staleOddsMs : this.thresholds.staleScoreMs;
    return {
      status: state.stale || ageMs > thresholdMs ? "stale" : "healthy",
      lastReceivedTimestamp: new Date(state.lastReceivedAt).toISOString(),
      ageMs
    };
  }

  private rememberId(state: FeedState, id: string): void {
    state.seenIds.add(id);
    while (state.seenIds.size > this.thresholds.seenIdLimitPerFeed) {
      const oldest = state.seenIds.values().next().value;
      if (oldest === undefined) break;
      state.seenIds.delete(oldest);
    }
  }

  private shouldReport(issueKey: string): boolean {
    if (this.reportedIssues.has(issueKey)) return false;
    this.reportedIssues.add(issueKey);
    while (this.reportedIssues.size > this.thresholds.seenIdLimitPerFeed * 2) {
      const oldest = this.reportedIssues.values().next().value;
      if (oldest === undefined) break;
      this.reportedIssues.delete(oldest);
    }
    return true;
  }

  private createAlert(
    type: AlertType,
    severity: AlertSeverity,
    fixtureId: string,
    feed: FeedKind,
    timestamp: string,
    message: string,
    metadata: Record<string, string | number | boolean>
  ): OperationalAlert {
    this.alertSequence += 1;
    return {
      id: `alert-${String(this.alertSequence).padStart(4, "0")}`,
      type,
      severity,
      fixtureId,
      feed,
      timestamp,
      message,
      correlationId: `quality:${fixtureId}:${feed}:${this.alertSequence}`,
      metadata
    };
  }
}
