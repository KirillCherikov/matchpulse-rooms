import type { AuditEvent } from "../domain/models.js";

export const DEFAULT_AUDIT_EVENT_LIMIT = 2_000;

export class AppendOnlyAuditLog {
  private readonly events: AuditEvent[] = [];
  private sequence = 0;
  private runId = "system";

  public constructor(private readonly maxEvents = DEFAULT_AUDIT_EVENT_LIMIT) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Audit event limit must be a positive integer");
    }
  }

  public beginRun(runId: string): void {
    this.runId = runId;
  }

  public append(
    type: AuditEvent["type"],
    timestamp: string,
    correlationId: string,
    data: Record<string, unknown>
  ): AuditEvent {
    if (this.events.length >= this.maxEvents) {
      throw new Error("Audit event capacity reached; refusing to mutate unaudited state");
    }
    this.sequence += 1;
    const event: AuditEvent = {
      id: `audit-${String(this.sequence).padStart(5, "0")}`,
      sequence: this.sequence,
      runId: this.runId,
      correlationId,
      type,
      timestamp,
      data: structuredClone(data)
    };
    this.events.push(event);
    return structuredClone(event);
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

  public remainingCapacity(): number {
    return this.maxEvents - this.events.length;
  }
}
