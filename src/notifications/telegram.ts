import type { AgentStatus, OperationalAlert, PaperPosition, Signal } from "../domain/models.js";

export interface TelegramRuntimeConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  highConfidenceScore: number;
}

export interface TelegramReadModel {
  status(): AgentStatus;
  allSignals(): Signal[];
  allAlerts(): OperationalAlert[];
  positions(): PaperPosition[];
}

/** Optional outbound integration. It is inert unless both secrets and the explicit feature flag are set. */
export class TelegramNotifier {
  public constructor(private readonly config: TelegramRuntimeConfig) {}

  public async notifyHighConfidenceSignal(signal: Signal): Promise<boolean> {
    if (signal.ruleBasedConfidenceScore < this.config.highConfidenceScore) return false;
    return this.send(
      [
        "TxLINE Sentinel high-confidence signal",
        `${selectionLabel(signal.selection)} ${formatPercent(signal.movement.percentagePointMovement / 100)} movement`,
        `Rule-based confidence score: ${formatPercent(signal.ruleBasedConfidenceScore)}`,
        `Decision: ${signal.paperDecision}`,
        "SIMULATION ONLY — NO REAL MONEY"
      ].join("\n")
    );
  }

  public async notifyOperationalAlert(alert: OperationalAlert): Promise<boolean> {
    if (alert.severity !== "critical") return false;
    return this.send(`TxLINE Sentinel operational alert\n${alert.type}\n${alert.message}`);
  }

  public async notifyRecovery(alert: OperationalAlert): Promise<boolean> {
    return this.send(`TxLINE Sentinel feed recovery\n${alert.message}`);
  }

  public commandReply(command: string, readModel: TelegramReadModel): string {
    const normalized = command.trim().toLowerCase().replace(/^\//, "");
    if (normalized === "status") {
      const status = readModel.status();
      return `Mode: ${status.mode}\nReplay: ${status.replay?.status ?? "unavailable"}\nSIMULATION ONLY — NO REAL MONEY`;
    }
    if (normalized === "signals") {
      const signal = readModel.allSignals().at(-1);
      return signal
        ? `Latest signal: ${selectionLabel(signal.selection)} · ${formatPercent(signal.ruleBasedConfidenceScore)} rule-based score · ${signal.paperDecision}`
        : "No signals have been generated.";
    }
    if (normalized === "alerts") {
      const alert = readModel.allAlerts().at(-1);
      return alert
        ? `Latest alert: ${alert.type} · ${alert.severity}\n${alert.message}`
        : "No operational alerts.";
    }
    if (normalized === "fixture") {
      const fixture = readModel.status().fixture;
      return fixture
        ? `${fixture.homeTeam} ${fixture.score.home}–${fixture.score.away} ${fixture.awayTeam} · ${fixture.minute}'`
        : "No current fixture.";
    }
    if (normalized === "positions") {
      const positions = readModel.positions();
      return positions.length === 0
        ? "No paper positions."
        : `Paper positions: ${positions.length}\nSIMULATION ONLY — NO REAL MONEY`;
    }
    return "Commands: /status, /signals, /alerts, /fixture, /positions";
  }

  private async send(text: string): Promise<boolean> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId) {
      return false;
    }
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.chatId, text }),
          signal: AbortSignal.timeout(5_000)
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

function selectionLabel(selection: Signal["selection"]): string {
  return selection === "home" ? "Home win" : selection === "away" ? "Away win" : "Draw";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
