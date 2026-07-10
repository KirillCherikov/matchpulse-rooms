import { describe, expect, it } from "vitest";
import { SentinelAgent } from "../../src/application/sentinel-agent.js";
import { loadConfig } from "../../src/config.js";

describe("Telegram feature flag", () => {
  it("renders command replies without a token or outbound request", () => {
    const agent = SentinelAgent.create({
      ...loadConfig({ SENTINEL_MODE: "replay" }),
      mode: "replay"
    });
    expect(agent.telegramCommand("/status")).toContain("SIMULATION ONLY — NO REAL MONEY");
    expect(agent.telegramCommand("/unknown")).toContain("/signals");
  });
});
