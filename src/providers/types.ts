import type { AgentMode, Fixture, ProviderMessage, ReplayState } from "../domain/models.js";

export interface TxLineProvider {
  readonly mode: AgentMode;
  fixtures(): Fixture[];
  readiness(): { ready: boolean; reason?: string };
}

export interface ControllableReplayProvider extends TxLineProvider {
  getReplayState(): ReplayState;
  start(speed?: ReplayState["speed"]): ReplayState;
  pause(): ReplayState;
  resume(): ReplayState;
  reset(): ReplayState;
  advance(): ProviderMessage | undefined;
}
