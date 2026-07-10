import { describe, expect, it } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";
import { LiveTxLineProvider } from "../../src/providers/live.js";
import { oddsUpdate } from "../helpers.js";

describe("live provider safety boundary", () => {
  it("fails readiness closed until the documented transport is configured", () => {
    expect(new LiveTxLineProvider(false).readiness()).toEqual({
      ready: false,
      reason: "Live mode requires documented TxLINE credentials and transport."
    });
  });

  it("validates payloads and bounds its diagnostic message cache", () => {
    const provider = new LiveTxLineProvider(true, 2);
    provider.ingest(oddsUpdate("one", 1, 1));
    provider.ingest(oddsUpdate("two", 2, 2));
    provider.ingest(oddsUpdate("three", 3, 3));

    expect(provider.receivedMessages().map((message) => message.id)).toEqual(["two", "three"]);
    expect(() => provider.ingest({ kind: "odds" })).toThrow();
    expect(() =>
      provider.ingest({
        ...oddsUpdate("secret-reference", 4, 4),
        rawReference: "txline://odds/update?redacted=value"
      })
    ).toThrow("Raw references must be sanitized");
    expect(() =>
      provider.ingest({
        ...oddsUpdate("extreme", 4, 4),
        selections: [
          { selection: "home", decimalOdds: Number.MAX_VALUE },
          { selection: "draw", decimalOdds: 3.4 },
          { selection: "away", decimalOdds: 3.6 }
        ]
      })
    ).toThrow();
  });

  it("turns malformed injected live data into a sanitized operational alert and audit error", () => {
    const provider = new LiveTxLineProvider(true);
    const config = { ...loadConfig({ SENTINEL_MODE: "live" }), mode: "live" as const };
    const agent = new SentinelAgent(config, provider);

    expect(agent.ingestLivePayload({ kind: "score", fixtureId: "fixture-live" })).toBeUndefined();
    expect(agent.allAlerts()).toEqual([
      expect.objectContaining({
        type: "malformed_payload",
        severity: "critical",
        fixtureId: "fixture-live",
        feed: "score"
      })
    ]);
    expect(agent.audit().at(-1)).toMatchObject({
      type: "error",
      data: { reason: "live_payload_validation_failed", fixtureId: "fixture-live", feed: "score" }
    });
    expect(agent.exportAudit()).not.toContain("rawPayload");
    agent.ingestLivePayload({ kind: "score", fixtureId: "fixture-live", secret: "do-not-log" });
    expect(agent.allAlerts()).toHaveLength(1);
    expect(agent.exportAudit()).not.toContain("do-not-log");
  });
});
