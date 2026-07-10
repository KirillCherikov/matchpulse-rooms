import type { CorrelatedEvent, MatchEvent } from "../domain/models.js";

export class EventCorrelator {
  private readonly eventsByFixture = new Map<string, MatchEvent[]>();

  public constructor(
    private readonly correlationWindowMs: number,
    private readonly maxEventsPerFixture = 256
  ) {
    if (!Number.isFinite(correlationWindowMs) || correlationWindowMs < 0) {
      throw new Error("Correlation window must be a nonnegative finite number");
    }
    if (!Number.isInteger(maxEventsPerFixture) || maxEventsPerFixture < 1) {
      throw new Error("Correlation event limit must be a positive integer");
    }
  }

  public reset(): void {
    this.eventsByFixture.clear();
  }

  public record(event: MatchEvent): void {
    if (!event.confirmed) {
      return;
    }
    const eventSourceAt = new Date(event.sourceTimestamp).getTime();
    const events = (this.eventsByFixture.get(event.fixtureId) ?? []).filter(
      (candidate) =>
        eventSourceAt - new Date(candidate.sourceTimestamp).getTime() <= this.correlationWindowMs
    );
    events.push(structuredClone(event));
    if (events.length > this.maxEventsPerFixture) {
      events.splice(0, events.length - this.maxEventsPerFixture);
    }
    this.eventsByFixture.set(event.fixtureId, events);
  }

  public correlate(
    fixtureId: string,
    oddsSourceTimestamp: string,
    decisionReceivedTimestamp: string
  ): CorrelatedEvent | undefined {
    const oddsSourceAt = new Date(oddsSourceTimestamp).getTime();
    const decisionReceivedAt = new Date(decisionReceivedTimestamp).getTime();
    const candidates = (this.eventsByFixture.get(fixtureId) ?? [])
      .map((event): CorrelatedEvent | undefined => {
        const eventSourceAt = new Date(event.sourceTimestamp).getTime();
        const eventReceivedAt = new Date(event.receivedTimestamp).getTime();
        const sourceLagMs = oddsSourceAt - eventSourceAt;
        const confirmationLeadMs = decisionReceivedAt - eventReceivedAt;
        if (
          !Number.isFinite(sourceLagMs) ||
          !Number.isFinite(confirmationLeadMs) ||
          sourceLagMs < 0 ||
          sourceLagMs > this.correlationWindowMs ||
          confirmationLeadMs < 0
        ) {
          return undefined;
        }
        return {
          event: structuredClone(event),
          relationship:
            eventReceivedAt <= oddsSourceAt ? "post_event_reaction" : "late_event_confirmation",
          sourceLagMs,
          confirmationLeadMs
        };
      })
      .filter((candidate): candidate is CorrelatedEvent => candidate !== undefined)
      .sort((left, right) => left.sourceLagMs - right.sourceLagMs);
    return candidates[0];
  }
}
