import { ReplayTxLineProvider } from "./replay.js";
import { createSyntheticFixture, createSyntheticReplayMessages } from "./synthetic-replay.js";

export class MockTxLineProvider extends ReplayTxLineProvider {
  public constructor() {
    super([createSyntheticFixture()], createSyntheticReplayMessages(), "mock");
  }
}
