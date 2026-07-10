import { describe, expect, it } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";

function runToSettlement(): SentinelAgent {
  const agent = SentinelAgent.create({
    ...loadConfig({ SENTINEL_MODE: "replay" }),
    mode: "replay"
  });
  agent.startReplay(10);
  while (agent.status().replay?.status !== "finished") {
    agent.advanceReplay();
  }
  return agent;
}

describe("replay → signal → paper position → settlement → analytics → audit", () => {
  it("runs the full deterministic synthetic pipeline with explicit simulation label", () => {
    const agent = runToSettlement();
    const signal = agent.allSignals()[0];
    const position = agent.positions()[0];
    expect(agent.fixtures()[0]?.dataLabel).toBe("Synthetic demo data — not a real match");
    expect(signal?.correlatedEvent?.event.type).toBe("goal");
    expect(signal?.paperDecision).toBe("opened");
    expect(position?.status).toBe("settled");
    expect(position?.outcome).toBe("won");
    expect(agent.analytics().virtualPnl).toBeGreaterThan(0);
    expect(agent.allAlerts().map((alert) => alert.type)).toEqual(
      expect.arrayContaining([
        "duplicate_update",
        "sequence_gap",
        "out_of_order_update",
        "stale_feed",
        "feed_recovery",
        "delayed_update"
      ])
    );
    expect(agent.audit().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "normalized_input",
        "signal_decision",
        "paper_execution",
        "settlement"
      ])
    );
  });

  it("replays deterministically after reset", () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });
    agent.startReplay();
    for (let index = 0; index < 5; index += 1) agent.advanceReplay();
    const first = agent.allSignals()[0];
    agent.resetReplay();
    agent.startReplay();
    for (let index = 0; index < 5; index += 1) agent.advanceReplay();
    const second = agent.allSignals()[0];
    expect(second?.movement).toEqual(first?.movement);
    expect(second?.explanation).toEqual(first?.explanation);
  });
});
