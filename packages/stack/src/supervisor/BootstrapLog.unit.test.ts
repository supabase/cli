import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- unit fixture inspects bootstrap.log mode and size.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temp root for bootstrap.log.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- join fixture paths.
import { join } from "node:path";
import {
  openSupervisorBootstrapLog,
  SUPERVISOR_BOOTSTRAP_LOG,
  SUPERVISOR_BOOTSTRAP_LOG_MAX_BYTES,
} from "./BootstrapLog.ts";

describe("openSupervisorBootstrapLog", () => {
  it("creates an owner-only bootstrap log under the stack directory", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "supervisor-bootstrap-"));
    const stackId = "a".repeat(64);
    const opened = openSupervisorBootstrapLog(stateRoot, stackId);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    expect(opened.path).toBe(join(stateRoot, stackId, SUPERVISOR_BOOTSTRAP_LOG));
    expect(statSync(opened.path).mode & 0o777).toBe(0o600);
  });

  it("truncates a bootstrap log that already exceeded the cap", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "supervisor-bootstrap-"));
    const stackId = "b".repeat(64);
    const first = openSupervisorBootstrapLog(stateRoot, stackId);
    expect(first).toBeDefined();
    if (first === undefined) return;
    writeFileSync(first.path, "x".repeat(SUPERVISOR_BOOTSTRAP_LOG_MAX_BYTES + 1));
    const reopened = openSupervisorBootstrapLog(stateRoot, stackId);
    expect(reopened).toBeDefined();
    if (reopened === undefined) return;
    expect(readFileSync(reopened.path, "utf8")).toBe("");
  });
});
