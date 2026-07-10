import { describe, expect, it, vi } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";
import { LiveTxLineProvider } from "../../src/providers/live.js";
import { fixture, matchEvent, oddsUpdate, timestamp } from "../helpers.js";

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

    agent.ingestLivePayload({ kind: "odds", fixtureId: "fixture-other" });
    const alerts = agent.allAlerts();
    expect(new Set(alerts.map((alert) => alert.id)).size).toBe(2);
    for (const alert of alerts) {
      expect(
        agent
          .audit()
          .some(
            (event) =>
              event.type === "operational_alert" && event.correlationId === alert.correlationId
          )
      ).toBe(true);
    }
  });

  it("separates validation failure from processing capacity and never leaves an unaudited alert", () => {
    const provider = new LiveTxLineProvider(true);
    const config = { ...loadConfig({ SENTINEL_MODE: "live" }), mode: "live" as const };
    const malformedAgent = new SentinelAgent(config, provider, { auditEventLimit: 1 });

    expect(() => malformedAgent.ingestLivePayload({ kind: "score", fixtureId: "fixture" })).toThrow(
      /audit capacity/i
    );
    expect(malformedAgent.allAlerts()).toEqual([]);
    expect(malformedAgent.audit()).toEqual([]);

    const capacityProvider = new LiveTxLineProvider(true);
    const validAgent = new SentinelAgent(config, capacityProvider, {
      auditEventLimit: 2
    });
    expect(() => validAgent.ingestLivePayload(oddsUpdate("valid", 1, 1))).toThrow(
      /audit capacity/i
    );
    expect(validAgent.allAlerts()).toEqual([]);
    expect(validAgent.audit()).toEqual([]);
    expect(capacityProvider.receivedMessages()).toEqual([]);
  });

  it("uses wall-clock time to report silent live fixtures as stale", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(timestamp(0));
      const provider = new LiveTxLineProvider(true, 100, [fixture]);
      const base = loadConfig({ SENTINEL_MODE: "live" });
      const config = {
        ...base,
        mode: "live" as const,
        thresholds: { ...base.thresholds, staleOddsMs: 10_000, staleScoreMs: 10_000 }
      };
      const agent = new SentinelAgent(config, provider);
      agent.ingestLivePayload(oddsUpdate("live-odds", 1, 0));
      agent.ingestLivePayload(matchEvent("live-score", 1, 0));
      expect(agent.status().feedHealth.status).toBe("healthy");

      vi.setSystemTime(timestamp(20));
      expect(agent.status().feedHealth).toMatchObject({
        status: "degraded",
        odds: { status: "stale", ageMs: 20_000 },
        score: { status: "stale", ageMs: 20_000 }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
