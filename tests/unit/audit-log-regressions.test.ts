import { describe, expect, it } from "vitest";
import { AppendOnlyAuditLog } from "../../src/audit/audit-log.js";

describe("append-only audit log regressions", () => {
  it("fails closed at its configured in-memory capacity", () => {
    const log = new AppendOnlyAuditLog(1);
    log.append("error", "2026-01-01T12:00:00.000Z", "input:one", { safe: true });

    expect(() =>
      log.append("error", "2026-01-01T12:00:01.000Z", "input:two", { safe: true })
    ).toThrow("refusing to mutate unaudited state");
    expect(log.all()).toHaveLength(1);
  });

  it("does not expose a mutable reference from append or all", () => {
    const log = new AppendOnlyAuditLog();
    log.beginRun("replay-run-0001");
    const appended = log.append("error", "2026-01-01T12:00:00.000Z", "input:test", {
      reason: "original"
    });

    appended.type = "settlement";
    appended.data.reason = "mutated";
    const read = log.all();
    read[0]!.data.reason = "mutated again";

    expect(log.all()).toEqual([
      {
        id: "audit-00001",
        sequence: 1,
        runId: "replay-run-0001",
        correlationId: "input:test",
        type: "error",
        timestamp: "2026-01-01T12:00:00.000Z",
        data: { reason: "original" }
      }
    ]);
  });

  it("keeps a global audit sequence while distinguishing replay runs", () => {
    const log = new AppendOnlyAuditLog();
    log.beginRun("replay-run-0001");
    log.append("replay_control", "2026-01-01T12:00:00.000Z", "replay:start", {
      action: "start"
    });
    log.beginRun("replay-run-0002");
    log.append("replay_control", "2026-01-01T12:00:00.000Z", "replay:start", {
      action: "start"
    });

    expect(log.all().map(({ id, sequence, runId }) => ({ id, sequence, runId }))).toEqual([
      { id: "audit-00001", sequence: 1, runId: "replay-run-0001" },
      { id: "audit-00002", sequence: 2, runId: "replay-run-0002" }
    ]);
  });
});
