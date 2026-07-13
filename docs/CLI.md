# CLI

Run the CLI as `npm run cli -- <command>`. It loads `.env.local` and then `.env`, without overriding environment variables already supplied by the process.

| Command                                   | Purpose                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `health`                                  | Create a local agent and print its current mode and status.            |
| `txline check`                            | Inspect local live-provider configuration readiness.                   |
| `fixtures list`                           | List fixtures for the configured local provider.                       |
| `agent start`                             | Start the long-running API and production dashboard server.            |
| `signals list`                            | Run a fresh deterministic local replay and print its signals.          |
| `alerts list`                             | Run a fresh deterministic local replay and print operational alerts.   |
| `replay start --speed 10`                 | Create a local agent, start it, print initial state, and exit.         |
| `replay run`                              | Run a fresh local replay through settlement.                           |
| `backtest run`                            | Run the same deterministic evaluation and print analytics and signals. |
| `audit export --output ./data/audit.json` | Run replay and export its sanitized audit JSON.                        |
| `telegram preview /status`                | Render a supported Telegram reply locally without contacting Telegram. |

## Important process semantics

Most commands are one-shot utilities and do not connect to an already running `agent start` process. In particular, `replay start` does not persist a session after the CLI exits. Use the dashboard or REST API for continuing Start/Pause/Resume/Advance controls.

`signals list`, `alerts list`, `replay run`, `backtest run`, and `audit export` each create and complete their own clean replay. Their output is suitable for reproducible local inspection, not remote agent administration.

## Live check

`txline check` is a one-shot configuration/provider-boundary check, not a long-running connectivity probe. Start the server and inspect `/api/live/status` for authenticated HTTP/SSE state.

The separate pinned devnet tool supports simulation-first subscription, activation, live smoke, and fixture proof reproduction:

```bash
npm run txline:devnet -- preflight --wallet /absolute/path/outside/repo/devnet-wallet.json
npm run txline:devnet -- smoke --credentials-file .env.live.local
npm run txline:devnet -- verify-fixture \
  --wallet /absolute/path/outside/repo/devnet-wallet.json \
  --credentials-file .env.live.local
```

It refuses a wallet inside the repository or without mode `0600`. Broadcast requires a separate explicit confirmation flag after fresh pricing and simulation checks. Never paste a credential value into a command, log, screenshot, or document.

## Telegram preview

The preview command exercises deterministic command-response rendering only. The project does not currently run a Telegram webhook or polling receiver. Outbound notifications are a separate feature-flagged path.

## Simulation boundary

CLI paper outputs are virtual records. They do not place a bet, contact a bookmaker, or move funds.

> **SIMULATION ONLY — NO REAL MONEY**
