import type { AgentMode, Fixture, ProviderMessage, ReplayState } from "../domain/models.js";
import { parseProviderMessage } from "../domain/schemas.js";
import type { ControllableReplayProvider } from "./types.js";

const speeds = new Set<ReplayState["speed"]>([1, 2, 5, 10]);

export class ReplayTxLineProvider implements ControllableReplayProvider {
  public readonly mode: Extract<AgentMode, "replay" | "mock">;
  private cursor = 0;
  private status: ReplayState["status"] = "idle";
  private speed: ReplayState["speed"] = 1;
  private simulatedTime: string | undefined;

  public constructor(
    private readonly replayFixtures: Fixture[],
    replayMessages: ProviderMessage[],
    mode: Extract<AgentMode, "replay" | "mock"> = "replay"
  ) {
    this.mode = mode;
    this.messages = replayMessages.map((message) => parseProviderMessage(message));
  }

  private readonly messages: ProviderMessage[];

  public fixtures(): Fixture[] {
    return structuredClone(this.replayFixtures);
  }

  public readiness(): { ready: boolean; reason?: string } {
    return { ready: true };
  }

  public getReplayState(): ReplayState {
    return {
      status: this.status,
      speed: this.speed,
      cursor: this.cursor,
      totalEvents: this.messages.length,
      ...(this.simulatedTime ? { simulatedTime: this.simulatedTime } : {})
    };
  }

  public start(speed?: ReplayState["speed"]): ReplayState {
    if (speed !== undefined) {
      this.setSpeed(speed);
    }
    if (this.status === "finished") {
      this.reset();
    }
    this.status = "running";
    return this.getReplayState();
  }

  public pause(): ReplayState {
    if (this.status === "running") {
      this.status = "paused";
    }
    return this.getReplayState();
  }

  public resume(): ReplayState {
    if (this.status === "paused" || this.status === "idle") {
      this.status = "running";
    }
    return this.getReplayState();
  }

  public reset(): ReplayState {
    this.cursor = 0;
    this.status = "idle";
    this.simulatedTime = undefined;
    return this.getReplayState();
  }

  public advance(): ProviderMessage | undefined {
    if (this.status === "idle") {
      this.status = "paused";
    }
    const message = this.messages[this.cursor];
    if (!message) {
      this.status = "finished";
      return undefined;
    }
    this.cursor += 1;
    this.simulatedTime = message.receivedTimestamp;
    if (this.cursor >= this.messages.length) {
      this.status = "finished";
    }
    return structuredClone(message);
  }

  private setSpeed(speed: ReplayState["speed"]): void {
    if (!speeds.has(speed)) {
      throw new Error("Replay speed must be one of 1x, 2x, 5x, or 10x");
    }
    this.speed = speed;
  }
}
