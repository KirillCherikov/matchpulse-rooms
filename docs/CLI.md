# CLI

Run the CLI as `npm run cli -- <command>`. It loads `.env.local` and then `.env`, without overriding environment variables already supplied by the process.

| Command                                   | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `health`                                  | Create a local agent and print its current mode and status.             |
| `txline check`                            | Force a live-provider readiness check without sending a TxLINE request. |
| `fixtures list`                           | List fixtures for the configured local provider.                        |
| `agent start`                             | Start the long-running API and production dashboard server.             |
| `signals list`                            | Run a fresh deterministic local replay and print its signals.           |
| `alerts list`                             | Run a fresh deterministic local replay and print operational alerts.    |
| `replay start --speed 10`                 | Create a local agent, start it, print initial state, and exit.          |
| `replay run`                              | Run a fresh local replay through settlement.                            |
| `backtest run`                            | Run the same deterministic evaluation and print analytics and signals.  |
| `audit export --output ./data/audit.json` | Run replay and export its sanitized audit JSON.                         |
| `telegram preview /status`                | Render a supported Telegram reply locally without contacting Telegram.  |

## Important process semantics

Most commands are one-shot utilities and do not connect to an already running `agent start` process. In particular, `replay start` does not persist a session after the CLI exits. Use the dashboard or REST API for continuing Start/Pause/Resume/Advance controls.

`signals list`, `alerts list`, `replay run`, `backtest run`, and `audit export` each create and complete their own clean replay. Their output is suitable for reproducible local inspection, not remote agent administration.

## Live check

`txline check` instantiates the live-provider boundary even when the default application mode is replay. Until an official network transport is implemented, it honestly returns not ready and a blocker reason. It does not send an HTTP request or perform an on-chain transaction.

## Telegram preview

The preview command exercises deterministic command-response rendering only. The project does not currently run a Telegram webhook or polling receiver. Outbound notifications are a separate feature-flagged path.

## Simulation boundary

CLI paper outputs are virtual records. They do not place a bet, contact a bookmaker, or move funds.

> **SIMULATION ONLY — NO REAL MONEY**
