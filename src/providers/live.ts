import type { Fixture, ProviderMessage } from "../domain/models.js";
import { parseProviderMessage } from "../domain/schemas.js";
import type { TxLineProvider } from "./types.js";

/**
 * Live transport is intentionally injected. No endpoint, header, program ID, or schema is guessed here;
 * an official TxLINE adapter must supply authenticated payloads after its documented contract is available.
 */
export class LiveTxLineProvider implements TxLineProvider {
  public readonly mode = "live" as const;
  private readonly received: ProviderMessage[] = [];

  public constructor(private readonly enabled: boolean) {}

  public fixtures(): Fixture[] {
    return [];
  }

  public readiness(): { ready: boolean; reason?: string } {
    return this.enabled
      ? { ready: false, reason: "Official TxLINE transport adapter is not configured." }
      : { ready: false, reason: "Live mode requires documented TxLINE credentials and transport." };
  }

  public ingest(rawPayload: unknown): ProviderMessage {
    const message = parseProviderMessage(rawPayload);
    this.received.push(message);
    return structuredClone(message);
  }

  public receivedMessages(): ProviderMessage[] {
    return structuredClone(this.received);
  }
}
