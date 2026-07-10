import type {
  AlertSeverity,
  AlertType,
  FeedKind,
  OperationalAlert,
  ProviderMessage
} from "../domain/models.js";

interface FeedState {
  lastSequence?: number;
  lastReceivedAt?: number;
  stale: boolean;
  seenIds: Set<string>;
}

export interface DataQualityThresholds {
  staleOddsMs: number;
  staleScoreMs: number;
  delayedUpdateMs: number;
}

export interface QualityInspection {
  alerts: OperationalAlert[];
  shouldProcess: boolean;
}

export class DataQualitySentinel {
  private readonly feeds = new Map<string, FeedState>();
  private alertSequence = 0;

  public constructor(private readonly thresholds: DataQualityThresholds) {}

  public reset(): void {
    this.feeds.clear();
    this.alertSequence = 0;
  }

  public inspect(message: ProviderMessage): QualityInspection {
    const feed = message.kind;
    const key = this.feedKey(message.fixtureId, feed);
    const state = this.feeds.get(key) ?? { stale: false, seenIds: new Set<string>() };
    const alerts: OperationalAlert[] = [];
    const receivedAt = new Date(message.receivedTimestamp).getTime();
    const sourceAt = new Date(message.sourceTimestamp).getTime();

    if (state.seenIds.has(message.id)) {
      alerts.push(
        this.createAlert(
          "duplicate_update",
          "warning",
          message.fixtureId,
          feed,
          message.receivedTimestamp,
          `Duplicate ${feed} update ${message.id} was ignored.`,
          { sequence: message.sequence, updateId: message.id }
        )
      );
      return { alerts, shouldProcess: false };
    }

    if (state.lastSequence !== undefined) {
      if (message.sequence <= state.lastSequence) {
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
        return { alerts, shouldProcess: false };
      }
      if (message.sequence > state.lastSequence + 1) {
        alerts.push(
          this.createAlert(
            "sequence_gap",
            "warning",
            message.fixtureId,
            feed,
            message.receivedTimestamp,
            `A ${feed} sequence gap was detected between ${state.lastSequence} and ${message.sequence}.`,
            { previousSequence: state.lastSequence, sequence: message.sequence }
          )
        );
      }
    }

    const latencyMs = Math.max(0, receivedAt - sourceAt);
    if (latencyMs > this.thresholds.delayedUpdateMs) {
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
    state.seenIds.add(message.id);
    if (state.seenIds.size > 1_000) {
      const oldest = state.seenIds.values().next().value;
      if (oldest) {
        state.seenIds.delete(oldest);
      }
    }
    this.feeds.set(key, state);
    return { alerts, shouldProcess: true };
  }

  public checkStaleness(now: string): OperationalAlert[] {
    const alerts: OperationalAlert[] = [];
    const nowMs = new Date(now).getTime();
    for (const [key, state] of this.feeds.entries()) {
      if (state.lastReceivedAt === undefined || state.stale) {
        continue;
      }
      const [, fixtureId, feed] = key.split(":") as [string, string, FeedKind];
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

  private feedKey(fixtureId: string, feed: FeedKind): string {
    return `feed:${fixtureId}:${feed}`;
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
