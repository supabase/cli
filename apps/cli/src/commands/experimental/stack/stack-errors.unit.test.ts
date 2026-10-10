import { StackError } from "@supabase/stack/effect";
import { describe, expect, it } from "vitest";
import { LocalDbRunningError } from "../../../command-internal/db-bootstrap/local-db-running.ts";
import { DbSetupError } from "../../../command-internal/db-bootstrap/db-setup.ts";
import { TestDbRunError } from "../../../command-internal/test-db.errors.ts";
import { DbDumpRunError } from "../../db/dump/dump.errors.ts";
import { DeclarativeApplyError } from "../../db/schema/declarative/declarative.errors.ts";
import { FunctionsServeStackError } from "../../functions/serve/serve.errors.ts";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import { StackCommandDestroyError } from "./destroy/destroy.errors.ts";
import { StackCommandStartError } from "./start/start.errors.ts";
import { StackCommandStatusError } from "./status/status.errors.ts";

const classify = (error: unknown) => {
  const { error_fingerprint, error_kind, error_category } = classifyCliErrorActionability(error);
  return { error_fingerprint, error_kind, error_category };
};

describe("new stack error telemetry", () => {
  it("fingerprints each command reason separately", () => {
    expect(
      classify(new StackCommandStatusError({ reason: "not-found", message: "no stack" })),
    ).toMatchObject({ error_fingerprint: "tag:ExperimentalStackStatusError:not_found" });
    expect(
      classify(new StackCommandStatusError({ reason: "flags", message: "bad flags" })),
    ).toMatchObject({ error_fingerprint: "tag:ExperimentalStackStatusError:flags" });
    expect(classify(new StackCommandStartError({ reason: "seed", message: "seed" }))).toEqual({
      error_fingerprint: "tag:ExperimentalStackStartError:seed_buckets",
      error_kind: "user_actionable",
      error_category: "invalid_config",
    });
  });

  it("treats only a configured port's conflict as user-actionable", () => {
    const wrap = (kind: string) =>
      new StackCommandStartError({
        reason: "stack",
        message: "x",
        cause: new StackError({ operation: "startComposition", message: "x", kind }),
      });

    expect(classify(wrap("port-conflict"))).toEqual({
      error_fingerprint: "tag:ExperimentalStackStartError:port_conflict",
      error_kind: "user_actionable",
      error_category: "invalid_config",
    });
    expect(classify(wrap("port-allocation"))).toEqual({
      error_fingerprint: "tag:ExperimentalStackStartError:port_allocation",
      error_kind: "internal_bug",
      error_category: "runtime_crash",
    });
  });

  it("prefers the client reason, then the kind, then a failed outcome's kind", () => {
    const outcomes = new StackError({
      operation: "startComposition",
      message: "x",
      outcomes: [
        { id: "a", succeeded: true },
        { id: "b", succeeded: false, error: "y", kind: "health-timeout" },
      ],
    });
    const reason = new StackError({
      operation: "shutdown",
      message: "x",
      reason: "release-mismatch",
      kind: "owner-connection",
    });

    expect(
      classify(new StackCommandDestroyError({ reason: "stack", message: "x", cause: outcomes })),
    ).toEqual({
      error_fingerprint: "tag:ExperimentalStackDestroyError:health_timeout",
      error_kind: "internal_bug",
      error_category: "runtime_crash",
    });
    expect(
      classify(new StackCommandDestroyError({ reason: "stack", message: "x", cause: reason })),
    ).toMatchObject({ error_fingerprint: "tag:ExperimentalStackDestroyError:release_mismatch" });
  });

  it("reports a kind from a newer release as unclassified instead of failing", () => {
    const cause = new StackError({ operation: "start", message: "x", kind: "from-the-future" });

    expect(classify(new StackCommandStartError({ reason: "stack", message: "x", cause }))).toEqual({
      error_fingerprint: "tag:ExperimentalStackStartError:unclassified",
      error_kind: "unknown",
      error_category: "unknown",
    });
  });

  it("keeps the declaration of a wrapped CLI-owned error", () => {
    const cause = new DbSetupError({ reason: "registry_pull", message: "pull failed" });

    expect(
      classify(new StackCommandStartError({ reason: "stack", message: "x", cause })),
    ).toMatchObject({ error_fingerprint: "tag:ExperimentalStackStartError:registry_pull" });
  });

  it("classifies a raw StackError and keeps it through stack-backed database wrappers", () => {
    const cause = new StackError({ operation: "status", message: "x", kind: "state" });

    expect(classify(cause)).toEqual({
      error_fingerprint: "tag:StackError:state_file",
      error_kind: "user_actionable",
      error_category: "invalid_config",
    });
    expect(classify(new LocalDbRunningError({ message: "x", cause }))).toMatchObject({
      error_fingerprint: "tag:LocalDbRunningError:state_file",
    });
    expect(
      classify(
        new DbDumpRunError({
          message: "x",
          cause: new LocalDbRunningError({ message: "x", cause }),
        }),
      ),
    ).toMatchObject({ error_fingerprint: "tag:DbDumpRunError:state_file" });
    expect(classify(new TestDbRunError({ message: "x", cause }))).toMatchObject({
      error_fingerprint: "tag:TestDbRunError:state_file",
    });
    expect(
      classify(
        new DeclarativeApplyError({
          message: "x",
          connect: true,
          cause: new LocalDbRunningError({ message: "not running" }),
        }),
      ),
    ).toMatchObject({ error_fingerprint: "tag:DeclarativeApplyError:connect" });
    expect(
      classify(new FunctionsServeStackError({ reason: "runtime", message: "log stream ended" })),
    ).toMatchObject({ error_fingerprint: "tag:FunctionsServeStackError:runtime_stopped" });
    expect(
      classify(
        new FunctionsServeStackError({
          reason: "lifecycle",
          message: "x",
          cause: new LocalDbRunningError({ message: "not running" }),
        }),
      ),
    ).toMatchObject({
      error_fingerprint: "tag:FunctionsServeStackError:lifecycle",
      error_category: "invalid_config",
    });
    expect(
      classify(
        new DbDumpRunError({
          message: "x",
          cause: new StackError({ operation: "status", message: "no kind" }),
        }),
      ),
    ).toMatchObject({ error_fingerprint: "tag:DbDumpRunError", error_category: "db_connection" });
    expect(classify(new TestDbRunError({ message: "exit 1" }))).toMatchObject({
      error_fingerprint: "tag:TestDbRunError",
      error_category: "invalid_config",
    });
    expect(classify(new LocalDbRunningError({ message: "not running" }))).toMatchObject({
      error_fingerprint: "tag:LocalDbRunningError",
      error_category: "invalid_config",
    });
  });
});
