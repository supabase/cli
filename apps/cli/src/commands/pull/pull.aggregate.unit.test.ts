import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { LegacyDbPullMigrationConflictError } from "../db/pull/pull.errors.ts";
import {
  legacyPullAggregate,
  legacyPullConfigStepResult,
  legacyPullCounts,
  legacyPullDbStepResult,
  legacyPullFailedStepResult,
  legacyPullFunctionsStepResult,
  legacyPullMigrationHistoryStepResult,
  type LegacyPullConfigStepOutcome,
  type LegacyPullDbStepOutcome,
  type LegacyPullFunctionsStepOutcome,
  type LegacyPullMigrationHistoryStepOutcome,
} from "./pull.aggregate.ts";
import type { LegacyPullStepResult } from "./pull.types.ts";

describe("legacyPullConfigStepResult", () => {
  const payload = { schema_version: 1 };

  it("reports unchanged when the plan had no work at all, even if confirmed and not a dry run", () => {
    const outcome: LegacyPullConfigStepOutcome = {
      dryRun: false,
      hasWork: false,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    expect(legacyPullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "unchanged",
      written: [],
      detail: payload,
    });
  });

  it("reports planned for a dry run that has work", () => {
    const outcome: LegacyPullConfigStepOutcome = {
      dryRun: true,
      hasWork: true,
      confirmed: false,
      configFilePath: "supabase/config.toml",
    };
    expect(legacyPullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "planned",
      written: [],
      detail: payload,
    });
  });

  it("reports planned for a declined confirmation that has work, identically to a dry run", () => {
    const outcome: LegacyPullConfigStepOutcome = {
      dryRun: false,
      hasWork: true,
      confirmed: false,
      configFilePath: "supabase/config.toml",
    };
    expect(legacyPullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "planned",
      written: [],
      detail: payload,
    });
  });

  it("reports changed and writes the config file path once actually applied", () => {
    const outcome: LegacyPullConfigStepOutcome = {
      dryRun: false,
      hasWork: true,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    expect(legacyPullConfigStepResult(outcome, payload)).toEqual({
      step: "config",
      status: "changed",
      written: ["supabase/config.toml"],
      detail: payload,
    });
  });

  it("passes the payload through verbatim as detail, regardless of status", () => {
    const outcome: LegacyPullConfigStepOutcome = {
      dryRun: false,
      hasWork: false,
      confirmed: true,
      configFilePath: "supabase/config.toml",
    };
    const richPayload = { schema_version: 1, changes: [{ path: ["api", "max_rows"] }] };
    expect(legacyPullConfigStepResult(outcome, richPayload).detail).toBe(richPayload);
  });
});

describe("legacyPullMigrationHistoryStepResult", () => {
  it("reports skipped with reason not_needed", () => {
    const outcome: LegacyPullMigrationHistoryStepOutcome = {
      kind: "skipped",
      reason: "not_needed",
    };
    expect(legacyPullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: "not_needed",
    });
  });

  it("reports skipped with reason declined", () => {
    const outcome: LegacyPullMigrationHistoryStepOutcome = { kind: "skipped", reason: "declined" };
    expect(legacyPullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: "declined",
    });
  });

  it("reports planned for a dry run that would have fetched", () => {
    const outcome: LegacyPullMigrationHistoryStepOutcome = { kind: "planned" };
    expect(legacyPullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "planned",
      written: [],
      detail: { files: [] },
    });
  });

  it("reports unchanged when fetched but no files were written", () => {
    const outcome: LegacyPullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: { files: [] },
      workdir: "/home/user/project",
    };
    expect(legacyPullMigrationHistoryStepResult(outcome)).toEqual({
      step: "migration_history",
      status: "unchanged",
      written: [],
      detail: { files: [] },
    });
  });

  it("reports changed and strips the workdir prefix off each written file", () => {
    const outcome: LegacyPullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: {
        files: [
          "/home/user/project/supabase/migrations/20240101000000_remote.sql",
          "/home/user/project/supabase/migrations/20240102000000_remote.sql",
        ],
      },
      workdir: "/home/user/project",
    };
    expect(legacyPullMigrationHistoryStepResult(outcome)).toEqual({
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
    const outcome: LegacyPullMigrationHistoryStepOutcome = {
      kind: "fetched",
      outcome: { files: ["/elsewhere/supabase/migrations/20240101000000_remote.sql"] },
      workdir: "/home/user/project",
    };
    expect(legacyPullMigrationHistoryStepResult(outcome).written).toEqual([
      "/elsewhere/supabase/migrations/20240101000000_remote.sql",
    ]);
  });
});

describe("legacyPullDbStepResult", () => {
  it("reports planned for a dry run", () => {
    const outcome: LegacyPullDbStepOutcome = { kind: "planned" };
    expect(legacyPullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "planned",
      written: [],
      detail: {},
    });
  });

  it("reports unchanged when the remote is already in sync", () => {
    const outcome: LegacyPullDbStepOutcome = { kind: "in_sync" };
    expect(legacyPullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "unchanged",
      written: [],
      detail: { in_sync: true },
    });
  });

  it("reports changed for a declarative pull, stripping the workdir prefix off the schema file", () => {
    const outcome: LegacyPullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "declarative",
        schemaWritten: "/home/user/project/supabase/schemas/prod.sql",
        engine: "pg-delta",
      },
      workdir: "/home/user/project",
    };
    expect(legacyPullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "changed",
      written: ["supabase/schemas/prod.sql"],
      detail: { declarative: true, engine: "pg-delta" },
    });
  });

  it("reports changed for a migration-mode pull, listing every schema file and the engine/history flag", () => {
    const outcome: LegacyPullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "migration",
        schemaFiles: ["/home/user/project/supabase/migrations/20240101000000_remote_schema.sql"],
        remoteHistoryUpdated: true,
        engine: "migra",
      },
      workdir: "/home/user/project",
    };
    expect(legacyPullDbStepResult(outcome)).toEqual({
      step: "db",
      status: "changed",
      written: ["supabase/migrations/20240101000000_remote_schema.sql"],
      detail: { declarative: false, engine: "migra", remote_history_updated: true },
    });
  });

  it("reports migration-mode remote_history_updated:false verbatim when db pull skipped updating the remote table", () => {
    const outcome: LegacyPullDbStepOutcome = {
      kind: "applied",
      outcome: {
        kind: "migration",
        schemaFiles: ["/home/user/project/supabase/migrations/20240101000000_remote_schema.sql"],
        remoteHistoryUpdated: false,
        engine: "pg-delta",
      },
      workdir: "/home/user/project",
    };
    expect(legacyPullDbStepResult(outcome).detail).toEqual({
      declarative: false,
      engine: "pg-delta",
      remote_history_updated: false,
    });
  });
});

describe("legacyPullFunctionsStepResult", () => {
  it("reports planned for a dry run", () => {
    const outcome: LegacyPullFunctionsStepOutcome = { kind: "planned" };
    expect(legacyPullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "planned",
      written: [],
      detail: {},
    });
  });

  it("reports unchanged when the project has no functions at all", () => {
    const outcome: LegacyPullFunctionsStepOutcome = {
      kind: "downloaded",
      result: { projectRef: "abcdefghijklmnopqrst", slugs: [], empty: true },
    };
    expect(legacyPullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "unchanged",
      written: [],
      detail: { project_ref: "abcdefghijklmnopqrst", function_slugs: [] },
    });
  });

  it("reports changed with one representative directory path per downloaded slug", () => {
    const outcome: LegacyPullFunctionsStepOutcome = {
      kind: "downloaded",
      result: { projectRef: "abcdefghijklmnopqrst", slugs: ["hello", "world"], empty: false },
    };
    expect(legacyPullFunctionsStepResult(outcome)).toEqual({
      step: "functions",
      status: "changed",
      written: ["supabase/functions/hello", "supabase/functions/world"],
      detail: { project_ref: "abcdefghijklmnopqrst", function_slugs: ["hello", "world"] },
    });
  });
});

describe("legacyPullFailedStepResult", () => {
  it("extracts message and suggestion from a real Cause.squash-produced tagged error", () => {
    const error = new LegacyDbPullMigrationConflictError({
      message: "remote migration history does not match local files",
      suggestion: "Run supabase migration repair to reconcile the history table.",
    });
    const squashed = Cause.squash(Cause.fail(error));
    expect(legacyPullFailedStepResult("db", squashed)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: {
        message: "remote migration history does not match local files",
        suggestion: "Run supabase migration repair to reconcile the history table.",
      },
    });
  });

  it("falls back to no suggestion for a plain Error, using its message", () => {
    const error = new Error("ECONNREFUSED: connection refused");
    expect(legacyPullFailedStepResult("functions", error)).toEqual({
      step: "functions",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "ECONNREFUSED: connection refused" },
    });
  });

  it("uses a bare string cause as the message directly", () => {
    expect(legacyPullFailedStepResult("config", "something went wrong")).toEqual({
      step: "config",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "something went wrong" },
    });
  });

  it("falls back to String(cause) for a value with neither a message nor a suggestion", () => {
    expect(legacyPullFailedStepResult("migration_history", { code: "EFAIL" })).toEqual({
      step: "migration_history",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "[object Object]" },
    });
  });

  it("falls back to String(cause) for null and undefined without throwing", () => {
    expect(legacyPullFailedStepResult("db", null)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "null" },
    });
    expect(legacyPullFailedStepResult("db", undefined)).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "undefined" },
    });
  });

  it("treats an empty-string message as absent and falls back to String(cause), rather than reporting a blank failure message", () => {
    expect(legacyPullFailedStepResult("config", { message: "" })).toEqual({
      step: "config",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "[object Object]" },
    });
  });

  it("drops an empty-string suggestion rather than including a blank one", () => {
    expect(legacyPullFailedStepResult("db", { message: "boom", suggestion: "" })).toEqual({
      step: "db",
      status: "failed",
      written: [],
      detail: {},
      failure: { message: "boom" },
    });
  });
});

describe("legacyPullCounts", () => {
  function result(
    status: LegacyPullStepResult["status"],
    step: LegacyPullStepResult["step"],
  ): LegacyPullStepResult {
    return { step, status, written: [], detail: {} };
  }

  it("returns every count at zero for an empty result list", () => {
    expect(legacyPullCounts([])).toEqual({
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
    expect(legacyPullCounts(results)).toEqual({
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
    expect(legacyPullCounts(results)).toEqual({
      changed: 1,
      unchanged: 1,
      skipped: 1,
      planned: 0,
      failed: 1,
    });
  });
});

describe("legacyPullAggregate", () => {
  it("passes every field through unchanged", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
    ];
    expect(
      legacyPullAggregate({
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
    const results: ReadonlyArray<LegacyPullStepResult> = [
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
    const aggregate = legacyPullAggregate({
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
