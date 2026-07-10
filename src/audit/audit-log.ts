import type { AuditEvent } from "../domain/models.js";

export class AppendOnlyAuditLog {
  private readonly events: AuditEvent[] = [];
  private sequence = 0;

  public append(
    type: AuditEvent["type"],
    timestamp: string,
    correlationId: string,
    data: Record<string, unknown>
  ): AuditEvent {
    this.sequence += 1;
    const event: AuditEvent = {
      id: `audit-${String(this.sequence).padStart(5, "0")}`,
      sequence: this.sequence,
      correlationId,
      type,
      timestamp,
      data: structuredClone(data)
    };
    this.events.push(event);
    return event;
  }

  public all(limit?: number): AuditEvent[] {
    const events = limit === undefined ? this.events : this.events.slice(-limit);
    return structuredClone(events);
  }

  public exportJson(): string {
    return JSON.stringify(this.events, null, 2);
  }

  public count(): number {
    return this.events.length;
  }
}
