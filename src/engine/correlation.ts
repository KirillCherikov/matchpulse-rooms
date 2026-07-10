import type { CorrelatedEvent, MatchEvent } from "../domain/models.js";

export class EventCorrelator {
  private readonly eventsByFixture = new Map<string, MatchEvent[]>();

  public constructor(private readonly correlationWindowMs: number) {}

  public reset(): void {
    this.eventsByFixture.clear();
  }

  public record(event: MatchEvent): void {
    if (!event.confirmed) {
      return;
    }
    const events = this.eventsByFixture.get(event.fixtureId) ?? [];
    events.push(event);
    this.eventsByFixture.set(event.fixtureId, events);
  }

  public correlate(fixtureId: string, timestamp: string): CorrelatedEvent | undefined {
    const target = new Date(timestamp).getTime();
    const candidates = (this.eventsByFixture.get(fixtureId) ?? [])
      .map((event) => ({
        event,
        distanceMs: Math.abs(target - new Date(event.sourceTimestamp).getTime())
      }))
      .filter((candidate) => candidate.distanceMs <= this.correlationWindowMs)
      .sort((left, right) => left.distanceMs - right.distanceMs);
    return candidates[0];
  }
}
