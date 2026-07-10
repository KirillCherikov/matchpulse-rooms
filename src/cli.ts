import { Command, Option } from "commander";
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SentinelAgent } from "./application/sentinel-agent.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const program = new Command();
program
  .name("txline-sentinel")
  .description("TxLINE Sentinel replay-first operations CLI")
  .version("0.1.0");

program
  .command("health")
  .description("Print local agent health")
  .action(() => {
    const agent = SentinelAgent.create(loadConfig());
    print({ health: "ok", status: agent.status() });
  });

const txline = program.command("txline").description("TxLINE integration commands");
txline
  .command("check")
  .description("Check whether a documented live transport is configured")
  .action(() => {
    const agent = SentinelAgent.create({ ...loadConfig(), mode: "live" });
    print(agent.readiness());
  });

const fixtures = program.command("fixtures").description("Fixture commands");
fixtures
  .command("list")
  .description("List replay fixtures")
  .action(() => {
    print({ fixtures: SentinelAgent.create(loadConfig()).fixtures() });
  });

const signals = program.command("signals").description("Signal commands");
signals
  .command("list")
  .description("Run replay and list generated signals")
  .action(() => {
    const agent = runReplay();
    print({ signals: agent.allSignals() });
  });

const alerts = program.command("alerts").description("Operational alert commands");
alerts
  .command("list")
  .description("Run replay and list data-quality alerts")
  .action(() => {
    const agent = runReplay();
    print({ alerts: agent.allAlerts() });
  });

const agentCommand = program.command("agent").description("Agent commands");
agentCommand
  .command("start")
  .description("Start the local API and dashboard server")
  .action(async () => {
    await startServer();
  });

const replay = program.command("replay").description("Deterministic replay controls");
replay
  .command("start")
  .addOption(
    new Option("--speed <speed>", "Replay speed: 1, 2, 5, or 10")
      .choices(["1", "2", "5", "10"])
      .default("1")
  )
  .description("Start a replay session and print its initial state")
  .action((options: { speed: string }) => {
    const agent = SentinelAgent.create(loadConfig());
    print({ replay: agent.startReplay(replaySpeed(options.speed)) });
  });
replay
  .command("run")
  .description("Run the full deterministic replay to settlement")
  .action(() => {
    const agent = runReplay();
    print({ status: agent.status(), analytics: agent.analytics(), positions: agent.positions() });
  });

const backtest = program.command("backtest").description("Backtest commands");
backtest
  .command("run")
  .description("Alias for deterministic replay evaluation")
  .action(() => {
    const agent = runReplay();
    print({ analytics: agent.analytics(), signals: agent.allSignals() });
  });

const audit = program.command("audit").description("Audit commands");
audit
  .command("export")
  .option("--output <path>", "Output JSON file", "./data/audit.json")
  .description("Run replay and export the sanitized append-only audit log")
  .action(async (options: { output: string }) => {
    const agent = runReplay();
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, agent.exportAudit(), "utf8");
    print({ output, events: agent.audit().length });
  });

const telegram = program.command("telegram").description("Telegram feature-flag helpers");
telegram
  .command("preview <command>")
  .description("Render a Telegram command reply without contacting Telegram")
  .action((command: string) => {
    const agent = runReplay();
    print({ reply: agent.telegramCommand(command) });
  });

function runReplay(): SentinelAgent {
  const config = { ...loadConfig(), mode: "replay" as const };
  const agent = SentinelAgent.create(config);
  agent.startReplay(10);
  while (agent.status().replay?.status !== "finished") {
    agent.advanceReplay();
  }
  return agent;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function replaySpeed(value: string): 1 | 2 | 5 | 10 {
  switch (value) {
    case "1":
      return 1;
    case "2":
      return 2;
    case "5":
      return 5;
    case "10":
      return 10;
    default:
      throw new Error("Replay speed must be one of 1x, 2x, 5x, or 10x");
  }
}

void program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : "Unexpected CLI failure"}\n`
  );
  process.exitCode = 1;
});
