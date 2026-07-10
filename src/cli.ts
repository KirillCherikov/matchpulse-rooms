import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SentinelAgent } from "./application/sentinel-agent.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

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

program
  .command("txline-check")
  .description("Check whether a documented live transport is configured")
  .action(() => {
    const agent = SentinelAgent.create(loadConfig());
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

program
  .command("agent-start")
  .description("Start the local API and dashboard server")
  .action(async () => {
    await startServer();
  });

const replay = program.command("replay").description("Deterministic replay controls");
replay
  .command("start")
  .option("--speed <speed>", "Replay speed: 1, 2, 5, or 10", "1")
  .description("Start a replay session and print its initial state")
  .action((options: { speed: string }) => {
    const agent = SentinelAgent.create(loadConfig());
    print({ replay: agent.startReplay(Number(options.speed) as 1 | 2 | 5 | 10) });
  });
replay
  .command("run")
  .description("Run the full deterministic replay to settlement")
  .action(() => {
    const agent = runReplay();
    print({ status: agent.status(), analytics: agent.analytics(), positions: agent.positions() });
  });

program
  .command("backtest-run")
  .description("Alias for deterministic replay evaluation")
  .action(() => {
    const agent = runReplay();
    print({ analytics: agent.analytics(), signals: agent.allSignals() });
  });

program
  .command("audit-export")
  .option("--output <path>", "Output JSON file", "./data/audit.json")
  .description("Run replay and export the sanitized append-only audit log")
  .action(async (options: { output: string }) => {
    const agent = runReplay();
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, agent.exportAudit(), "utf8");
    print({ output, events: agent.audit().length });
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

void program.parseAsync(process.argv);
