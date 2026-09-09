import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { DbPullMigrationConflictError } from "../db/pull/pull.errors.ts";
import {
  pullAggregate,
  pullConfigStepResult,
  pullCounts,
  pullDbStepResult,
  pullFailedStepResult,
  pullFunctionsStepResult,
  pullMigrationHistoryStepResult,
  pullRetryHint,
  type PullConfigStepOutcome,
  type PullDbStepOutcome,
  type PullFunctionsStepOutcome,
  type PullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import type { PullStepResult } from "./pull.types.ts";

describe("pullConfigStepResult", () => {
  const payload = { schema_version: 1 };

  it("reports unchanged when the plan had no work at all, even if confirmed and not a dry run", () => {
    const outcome: PullConfigStepOutcome = {
      dryRun: false,
      hasWork: false,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    expect(pullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "unchanged",
      written: [],
      detail: payload,
    });
  });

  it("reports planned for a dry run that has work", () => {
    const outcome: PullConfigStepOutcome = {
      dryRun: true,
      hasWork: true,
      confirmed: false,
      configFilePath: "supabase/config.toml",
    };
    expect(pullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "planned",
      written: [],
      detail: payload,
    });
  });

  it("reports planned for a declined confirmation that has work, identically to a dry run", () => {
    const outcome: PullConfigStepOutcome = {
      dryRun: false,
      hasWork: true,
      confirmed: false,
      configFilePath: "supabase/config.toml",
    };
    expect(pullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "planned",
      written: [],
      detail: payload,
    });
  });

  it("reports changed and writes the config file path once actually applied", () => {
    const outcome: PullConfigStepOutcome = {
      dryRun: false,
      hasWork: true,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    expect(pullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "changed",
      written: ["supabase/config.toml"],
      detail: payload,
    });
  });

  it("passes the payload through verbatim as detail, regardless of status", () => {
    const outcome: PullConfigStepOutcome = {
      dryRun: false,
      hasWork: false,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    const richPayload = { schema_version: 1, changes: [{ path: ["api", "max_rows"] }] };
    expect(pullConfigStepResult(outcome, richPayload).detail).toBe(richPayload);
  });
});

describe("pullMigrationHistoryStepResult", () => {
  it("reports skipped with reason not_needed", () => {
    const outcome: PullMigrationHistoryStepOutcome = {
      kind: "skipped",
      reason: "not_needed",
    };
    expect(pullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: "not_needed",
    });
  });

  it("reports skipped with reason declined", () => {
    const outcome: PullMigrationHistoryStepOutcome = { kind: "skipped", reason: "declined" };
    expect(pullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: "declined",
    });
  });

  it("reports planned for a dry run that would have fetched", () => {
    const outcome: PullMigrationHistoryStepOutcome = { kind: "planned" };
    expect(pullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "planned",
      written: [],
      detail: { files: [] },
    });
  });

  it("reports unchanged when fetched but no files were written", () => {
    const outcome: PullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: { files: [] },
      workdir: "/home/user/project",
    };
    expect(pullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "unchanged",
      written: [],
      detail: { files: [] },
    });
  });

  it("reports changed and strips the workdir prefix off each written file", () => {
    const outcome: PullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: {
        files: [
          "/home/user/project/supabase/migrations/20240101000000_remote.sql",
          "/home/user/project/supabase/migrations/20240102000000_remote.sql",
        ],
      },
      workdir: "/home/user/project",
    };
    expect(pullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "changed",
      written: [
        "supabase/migrations/20240101000000_remote.sql",
        "supabase/migrations/20240102000000_remote.sql",
      ],
      detail: {
        files: [
          "supabase/migrations/20240101000000_remote.sql",
          "supabase/migrations/20240102000000_remote.sql",
        ],
      },
    });
  });

  it("leaves a written file untouched when it does not start with the workdir prefix", () => {
    const outcome: PullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: { files: ["/elsewhere/supabase/migrations/20240101000000_remote.sql"] },
      workdir: "/home/user/project",
    };
    expect(pullMigrationHistoryStepResult(outcome).written).toEqual([
      "/elsewhere/supabase/migrations/20240101000000_remote.sql",
    ]);
  });
});

describe("pullDbStepResult", () => {
  it("reports planned for a dry run", () => {
    const outcome: PullDbStepOutcome = { kind: "planned" };
    expect(pullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "planned",
      written: [],
      detail: {},
    });
  });

  it("reports unchanged when the remote is already in sync", () => {
    const outcome: PullDbStepOutcome = { kind: "in_sync" };
    expect(pullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "unchanged",
      written: [],
      detail: { in_sync: true },
    });
  });

  it("reports changed for a declarative pull, stripping the workdir prefix off the schema file", () => {
    const outcome: PullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "declarative",
        schemaWritten: "/home/user/project/supabase/schemas/prod.sql",
        engine: "pg-delta",
      },
      workdir: "/home/user/project",
    };
    expect(pullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "changed",
      written: ["supabase/schemas/prod.sql"],
      detail: { declarative: true, engine: "pg-delta" },
    });
  });

  it("reports changed for a migration-mode pull, listing every schema file and the engine/history flag", () => {
    const outcome: PullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "migration",
        schemaFiles: ["/home/user/project/supabase/migrations/20240101000000_remote_schema.sql"],
        remoteHistoryUpdated: true,
        engine: "migra",
      },
      workdir: "/home/user/project",
    };
    expect(pullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "changed",
      written: ["supabase/migrations/20240101000000_remote_schema.sql"],
      detail: { declarative: false, engine: "migra", remote_history_updated: true },
    });
  });

  it("reports migration-mode remote_history_updated:false verbatim when db pull skipped updating the remote table", () => {
    const outcome: PullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "migration",
        schemaFiles: ["/home/user/project/supabase/migrations/20240101000000_remote_schema.sql"],
        remoteHistoryUpdated: false,
        engine: "pg-delta",
      },
      workdir: "/home/user/project",
    };
    expect(pullDbStepResult(outcome).detail).toEqual({
      declarative: false,
      engine: "pg-delta",
      remote_history_updated: false,
    });
  });
});

describe("pullFunctionsStepResult", () => {
  it("reports planned for a dry run", () => {
    const outcome: PullFunctionsStepOutcome = { kind: "planned" };
    expect(pullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "planned",
      written: [],
      detail: {},
    });
  });

  it("reports unchanged when the project has no functions at all", () => {
    const outcome: PullFunctionsStepOutcome = {
      kind: "downloaded",
      result: { projectRef: "abcdefghijklmnopqrst", slugs: [], empty: true },
    };
    expect(pullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "unchanged",
      written: [],
      detail: { project_ref: "abcdefghijklmnopqrst", function_slugs: [] },
    });
  });

  it("reports changed with one representative directory path per downloaded slug", () => {
    const outcome: PullFunctionsStepOutcome = {
      kind: "downloaded",
      result: { projectRef: "abcdefghijklmnopqrst", slugs: ["hello", "world"], empty: false },
    };
    expect(pullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "changed",
      written: ["supabase/functions/hello", "supabase/functions/world"],
      detail: { project_ref: "abcdefghijklmnopqrst", function_slugs: ["hello", "world"] },
    });
  });
});

describe("pullFailedStepResult", () => {
  it("extracts message, suggestion, and code (the squashed cause's own _tag) from a real Cause.squash-produced tagged error", () => {
    const error = new DbPullMigrationConflictError({
      message: "remote migration history does not match local files",
      suggestion: "Run supabase migration repair to reconcile the history table.",
    });
    const squashed = Cause.squash(Cause.fail(error));
    expect(pullFailedStepResult("db", squashed)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: {
        message: "remote migration history does not match local files",
        suggestion: "Run supabase migration repair to reconcile the history table.",
        code: "DbPullMigrationConflictError",
      },
    });
  });

  it("falls back to no suggestion for a plain Error, using its message", () => {
    const error = new Error("ECONNREFUSED: connection refused");
    expect(pullFailedStepResult("functions", error)).toEqual({
      step: "functions",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "ECONNREFUSED: connection refused" },
    });
  });

  it("uses a bare string cause as the message directly", () => {
    expect(pullFailedStepResult("config", "something went wrong")).toEqual({
      step: "config",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "something went wrong" },
    });
  });

  it("falls back to String(cause) for a value with neither a message nor a suggestion", () => {
    expect(pullFailedStepResult("migration_history", { code: "EFAIL" })).toEqual({
      step: "migration_history",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "[object Object]" },
    });
  });

  it("falls back to String(cause) for null and undefined without throwing", () => {
    expect(pullFailedStepResult("db", null)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "null" },
    });
    expect(pullFailedStepResult("db", undefined)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "undefined" },
    });
  });

  it("treats an empty-string message as absent and falls back to String(cause), rather than reporting a blank failure message", () => {
    expect(pullFailedStepResult("config", { message: "" })).toEqual({
      step: "config",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "[object Object]" },
    });
  });

  it("drops an empty-string suggestion rather than including a blank one", () => {
    expect(pullFailedStepResult("db", { message: "boom", suggestion: "" })).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "boom" },
    });
  });
});

describe("pullRetryHint", () => {
  const ref = "abcdefghijklmnopqrst";

  it("names 'supabase config pull --project-ref <ref>' for the config step", () => {
    expect(pullRetryHint("config", ref, undefined)).toBe(
      "To retry just this step, run: supabase config pull --project-ref abcdefghijklmnopqrst",
    );
  });

  it("appends --remote-label to the config hint when one was passed", () => {
    expect(pullRetryHint("config", ref, "staging-remote")).toBe(
      "To retry just this step, run: supabase config pull --project-ref abcdefghijklmnopqrst --remote-label staging-remote",
    );
  });

  it("names 'supabase migration fetch --project-ref <ref>' for the migration_history step", () => {
    expect(pullRetryHint("migration_history", ref, undefined)).toBe(
      "To retry just this step, run: supabase migration fetch --project-ref abcdefghijklmnopqrst",
    );
  });

  it("names 'supabase db pull --project-ref <ref>' for the db step", () => {
    expect(pullRetryHint("db", ref, undefined)).toBe(
      "To retry just this step, run: supabase db pull --project-ref abcdefghijklmnopqrst",
    );
  });

  it("names 'supabase functions download --project-ref <ref>' for the functions step", () => {
    expect(pullRetryHint("functions", ref, undefined)).toBe(
      "To retry just this step, run: supabase functions download --project-ref abcdefghijklmnopqrst",
    );
  });

  it("ignores a remote label for every step other than config", () => {
    expect(pullRetryHint("migration_history", ref, "staging-remote")).not.toContain(
      "--remote-label",
    );
    expect(pullRetryHint("db", ref, "staging-remote")).not.toContain("--remote-label");
    expect(pullRetryHint("functions", ref, "staging-remote")).not.toContain("--remote-label");
  });
});

describe("pullCounts", () => {
  function result(status: PullStepResult["status"], step: PullStepResult["step"]): PullStepResult {
    return { step, status, written: [], detail: {} };
  }

  it("returns every count at zero for an empty result list", () => {
    expect(pullCounts([])).toEqual({
      changed: 0,
      unchanged: 0,
      skipped: 0,
      planned: 0,
      failed: 0,
    });
  });

  it("counts all four steps under the same status", () => {
    const results = [
      result("changed", "config"),
      result("changed", "migration_history"),
      result("changed", "db"),
      result("changed", "functions"),
    ];
    expect(pullCounts(results)).toEqual({
      changed: 4,
      unchanged: 0,
      skipped: 0,
      planned: 0,
      failed: 0,
    });
  });

  it("counts a mix of every status exactly once", () => {
    const results = [
      result("changed", "config"),
      result("unchanged", "migration_history"),
      result("skipped", "db"),
      result("failed", "functions"),
    ];
    expect(pullCounts(results)).toEqual({
      changed: 1,
      unchanged: 1,
      skipped: 1,
      planned: 0,
      failed: 1,
    });
  });
});

describe("pullAggregate", () => {
  it("passes every field through unchanged", () => {
    const results: ReadonlyArray<PullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
    ];
    expect(
      pullAggregate({
        ref: "abcdefghijklmnopqrst",
        branch: "staging",
        dryRun: true,
        confirmed: false,
        results,
      }),
    ).toEqual({
      ref: "abcdefghijklmnopqrst",
      branch: "staging",
      dryRun: true,
      confirmed: false,
      results,
    });
  });

  it("does not mutate or reorder the input results array", () => {
    const results: ReadonlyArray<PullStepResult> = [
      { step: "config", status: "changed", written: [], detail: {} },
      {
        step: "migration_history",
        status: "skipped",
        written: [],
        detail: {},
        reason: "not_needed",
      },
      { step: "db", status: "unchanged", written: [], detail: {} },
      { step: "functions", status: "planned", written: [], detail: {} },
    ];
    const frozen = Object.freeze([...results]);
    const aggregate = pullAggregate({
      ref: "abcdefghijklmnopqrst",
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results: frozen,
    });
    expect(aggregate.results).toBe(frozen);
    expect(aggregate.results.map((result) => result.step)).toEqual([
      "config",
      "migration_history",
      "db",
      "functions",
    ]);
  });
});
