import { describe, expect, it } from "vitest";

import {
  LEGACY_PULL_PAYLOAD_VERSION,
  legacyPullConfirmMessage,
  legacyPullDirtyWarningMessage,
  legacyPullPayload,
  legacyPullSummaryMessage,
  legacyRenderPullSummary,
  type LegacyPullConfirmMessageInput,
} from "./pull.format.ts";
import {
  LEGACY_PULL_STEP_ORDER,
  type LegacyPullAggregate,
  type LegacyPullStepResult,
} from "./pull.types.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";

describe("legacyPullPayload", () => {
  it("shapes a dry-run aggregate: every step planned, no branch, wrote:false", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      {
        step: "config",
        status: "planned",
        written: [],
        detail: { schema_version: 1, wrote: false },
      },
      { step: "migration_history", status: "planned", written: [], detail: { files: [] } },
      { step: "db", status: "planned", written: [], detail: {} },
      { step: "functions", status: "planned", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: true,
      confirmed: false,
      results,
    };

    expect(legacyPullPayload(aggregate)).toEqual({
      schema_version: LEGACY_PULL_PAYLOAD_VERSION,
      target: { project_ref: PROJECT_REF },
      dry_run: true,
      confirmed: false,
      wrote: false,
      step_order: ["config", "migration_history", "db", "functions"],
      steps: {
        config: { status: "planned", written: [], detail: { schema_version: 1, wrote: false } },
        migration_history: { status: "planned", written: [], detail: { files: [] } },
        db: { status: "planned", written: [], detail: {} },
        functions: { status: "planned", written: [], detail: {} },
      },
      counts: { changed: 0, unchanged: 0, skipped: 0, planned: 4, failed: 0 },
    });
  });

  it("shapes a fully-succeeded aggregate: every step changed, branch present, wrote:true", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      {
        step: "config",
        status: "changed",
        written: ["supabase/config.toml"],
        detail: { schema_version: 1 },
      },
      {
        step: "migration_history",
        status: "changed",
        written: ["supabase/migrations/20240101000000_remote.sql"],
        detail: { files: ["supabase/migrations/20240101000000_remote.sql"] },
      },
      {
        step: "db",
        status: "changed",
        written: ["supabase/migrations/20240102000000_remote_schema.sql"],
        detail: { declarative: false, engine: "pg-delta", remote_history_updated: true },
      },
      {
        step: "functions",
        status: "changed",
        written: ["supabase/functions/hello"],
        detail: { project_ref: PROJECT_REF, function_slugs: ["hello"] },
      },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: "staging",
      dryRun: false,
      confirmed: true,
      results,
    };

    expect(legacyPullPayload(aggregate)).toEqual({
      schema_version: LEGACY_PULL_PAYLOAD_VERSION,
      target: { project_ref: PROJECT_REF, branch: "staging" },
      dry_run: false,
      confirmed: true,
      wrote: true,
      step_order: ["config", "migration_history", "db", "functions"],
      steps: {
        config: {
          status: "changed",
          written: ["supabase/config.toml"],
          detail: { schema_version: 1 },
        },
        migration_history: {
          status: "changed",
          written: ["supabase/migrations/20240101000000_remote.sql"],
          detail: { files: ["supabase/migrations/20240101000000_remote.sql"] },
        },
        db: {
          status: "changed",
          written: ["supabase/migrations/20240102000000_remote_schema.sql"],
          detail: { declarative: false, engine: "pg-delta", remote_history_updated: true },
        },
        functions: {
          status: "changed",
          written: ["supabase/functions/hello"],
          detail: { project_ref: PROJECT_REF, function_slugs: ["hello"] },
        },
      },
      counts: { changed: 4, unchanged: 0, skipped: 0, planned: 0, failed: 0 },
    });
  });

  it("shapes a declined aggregate: config/db/functions planned, migration_history skipped(declined), wrote:false", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "planned", written: [], detail: { schema_version: 1 } },
      {
        step: "migration_history",
        status: "skipped",
        written: [],
        detail: { files: [] },
        reason: "declined",
      },
      { step: "db", status: "planned", written: [], detail: {} },
      { step: "functions", status: "planned", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: false,
      results,
    };

    const payload = legacyPullPayload(aggregate);
    expect(payload["wrote"]).toBe(false);
    expect(payload["confirmed"]).toBe(false);
    expect(payload["dry_run"]).toBe(false);
    expect((payload["steps"] as Record<string, unknown>)["migration_history"]).toEqual({
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: "declined",
    });
    expect(payload["counts"]).toEqual({
      changed: 0,
      unchanged: 0,
      skipped: 1,
      planned: 3,
      failed: 0,
    });
  });

  it("shapes a mixed-failure aggregate: one step failed, wrote:true from the OTHER changed steps", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      {
        step: "config",
        status: "changed",
        written: ["supabase/config.toml"],
        detail: { schema_version: 1 },
      },
      {
        step: "migration_history",
        status: "failed",
        written: [],
        detail: {},
        failure: {
          message: "network timeout fetching migration history",
          suggestion: "Check your network connection and retry.",
        },
      },
      { step: "db", status: "unchanged", written: [], detail: { in_sync: true } },
      {
        step: "functions",
        status: "changed",
        written: ["supabase/functions/hello"],
        detail: { project_ref: PROJECT_REF, function_slugs: ["hello"] },
      },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };

    const payload = legacyPullPayload(aggregate);
    expect(payload["wrote"]).toBe(true);
    expect((payload["steps"] as Record<string, unknown>)["migration_history"]).toEqual({
      status: "failed",
      written: [],
      detail: {},
      failure: {
        message: "network timeout fetching migration history",
        suggestion: "Check your network connection and retry.",
      },
    });
    expect(payload["counts"]).toEqual({
      changed: 2,
      unchanged: 1,
      skipped: 0,
      planned: 0,
      failed: 1,
    });
  });

  it("always reports step_order as LEGACY_PULL_STEP_ORDER, verbatim and in order", () => {
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results: [],
    };
    expect(legacyPullPayload(aggregate)["step_order"]).toEqual(LEGACY_PULL_STEP_ORDER);
  });

  it("omits a step's key entirely from steps when no result was reported for it", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    const payload = legacyPullPayload(aggregate);
    expect(Object.keys(payload["steps"] as Record<string, unknown>)).toEqual(["config"]);
  });
});

describe("legacyPullSummaryMessage", () => {
  it("reads 'declined' and lists the actual counts when the confirmation was declined outside a dry run", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "planned", written: [], detail: {} },
      { step: "migration_history", status: "skipped", written: [], detail: {}, reason: "declined" },
      { step: "db", status: "planned", written: [], detail: {} },
      { step: "functions", status: "planned", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: false,
      results,
    };
    const message = legacyPullSummaryMessage(aggregate);
    expect(message).toBe(
      "Pull declined: nothing was changed (0 changed, 0 unchanged, 1 skipped, 3 planned, 0 failed).",
    );
  });

  it("reads 'preview (dry run)' and lists the actual counts for --dry-run", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "planned", written: [], detail: {} },
      { step: "migration_history", status: "planned", written: [], detail: {} },
      { step: "db", status: "planned", written: [], detail: {} },
      { step: "functions", status: "planned", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: true,
      confirmed: false,
      results,
    };
    expect(legacyPullSummaryMessage(aggregate)).toBe(
      "Pull preview (dry run): nothing was changed (0 changed, 0 unchanged, 0 skipped, 4 planned, 0 failed).",
    );
  });

  it("reads 'finished with failures' when at least one step failed", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
      {
        step: "migration_history",
        status: "failed",
        written: [],
        detail: {},
        failure: { message: "boom" },
      },
      { step: "db", status: "unchanged", written: [], detail: {} },
      { step: "functions", status: "changed", written: ["supabase/functions/a"], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    expect(legacyPullSummaryMessage(aggregate)).toBe(
      "Pull finished with failures: 2 changed, 1 unchanged, 0 skipped, 0 planned, 1 failed.",
    );
  });

  it("reads 'complete' once confirmed and nothing failed", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
      { step: "migration_history", status: "changed", written: ["a"], detail: {} },
      { step: "db", status: "changed", written: ["b"], detail: {} },
      { step: "functions", status: "changed", written: ["c"], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    expect(legacyPullSummaryMessage(aggregate)).toBe(
      "Pull complete: 4 changed, 0 unchanged, 0 skipped, 0 planned, 0 failed.",
    );
  });
});

describe("legacyRenderPullSummary", () => {
  function rowFor(text: string, step: string): string | undefined {
    return text.split("\n").find((line) => line.startsWith(`  ${step}`));
  }

  it("names the target project in the header and renders every step in LEGACY_PULL_STEP_ORDER order", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
      {
        step: "migration_history",
        status: "skipped",
        written: [],
        detail: {},
        reason: "not_needed",
      },
      {
        step: "db",
        status: "failed",
        written: [],
        detail: {},
        failure: { message: "shadow database container failed to start" },
      },
      {
        step: "functions",
        status: "changed",
        written: ["supabase/functions/a", "supabase/functions/b"],
        detail: {},
      },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };

    const text = legacyRenderPullSummary(aggregate);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Pull summary — project ${PROJECT_REF}`);

    const stepIndexes = LEGACY_PULL_STEP_ORDER.map((step) =>
      lines.findIndex((line) => line.startsWith(`  ${step}`)),
    );
    expect(stepIndexes.every((index) => index !== -1)).toBe(true);
    expect(stepIndexes).toEqual([...stepIndexes].sort((a, b) => a - b));

    expect(text.endsWith("\n")).toBe(true);
  });

  it("inlines a failed step's failure message on its own row", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "changed", written: ["supabase/config.toml"], detail: {} },
      { step: "migration_history", status: "unchanged", written: [], detail: {} },
      {
        step: "db",
        status: "failed",
        written: [],
        detail: {},
        failure: { message: "shadow database container failed to start" },
      },
      { step: "functions", status: "unchanged", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    const dbRow = rowFor(legacyRenderPullSummary(aggregate), "db");
    expect(dbRow).toContain("shadow database container failed to start");
  });

  it("inlines a skipped step's reason in parentheses", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "unchanged", written: [], detail: {} },
      {
        step: "migration_history",
        status: "skipped",
        written: [],
        detail: {},
        reason: "not_needed",
      },
      { step: "db", status: "unchanged", written: [], detail: {} },
      { step: "functions", status: "unchanged", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    const row = rowFor(legacyRenderPullSummary(aggregate), "migration_history");
    expect(row).toContain("(not_needed)");
  });

  it("shows only the first written path with a '+N more' suffix when a step wrote more than one file", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "unchanged", written: [], detail: {} },
      { step: "migration_history", status: "unchanged", written: [], detail: {} },
      { step: "db", status: "unchanged", written: [], detail: {} },
      {
        step: "functions",
        status: "changed",
        written: ["supabase/functions/a", "supabase/functions/b", "supabase/functions/c"],
        detail: {},
      },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    const row = rowFor(legacyRenderPullSummary(aggregate), "functions");
    expect(row).toContain("supabase/functions/a (+2 more)");
    expect(row).not.toContain("supabase/functions/b");
  });

  it("renders a failed step's suggestion as indented lines below its row, in order, so a text-mode user sees it too", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "unchanged", written: [], detail: {} },
      { step: "migration_history", status: "unchanged", written: [], detail: {} },
      {
        step: "db",
        status: "failed",
        written: [],
        detail: {},
        failure: {
          message: "remote migration history does not match local files",
          suggestion:
            "Make sure your local git repo is up-to-date.\n" +
            "Alternatively, rerun `supabase pull --with-migration-history` to fetch and reconcile the remote migration history table automatically.\n" +
            "To retry just this step, run: supabase db pull --project-ref abcdefghijklmnopqrst",
        },
      },
      { step: "functions", status: "unchanged", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };

    const text = legacyRenderPullSummary(aggregate);
    const lines = text.split("\n");
    const dbRowIndex = lines.findIndex((line) => line.startsWith("  db"));
    expect(lines[dbRowIndex + 1]).toContain("Make sure your local git repo is up-to-date.");
    expect(lines[dbRowIndex + 2]).toContain("Alternatively, rerun");
    expect(lines[dbRowIndex + 3]).toContain(
      "To retry just this step, run: supabase db pull --project-ref abcdefghijklmnopqrst",
    );
    // Continuation lines don't start with the step name, so a naive
    // step-row scanner (e.g. this suite's own `rowFor`/`stepLine` helpers)
    // never mistakes one for a fake status row.
    expect(lines[dbRowIndex + 1]!.trimStart().startsWith("db")).toBe(false);
  });

  it("adds no continuation lines for a failed step with no suggestion", () => {
    const results: ReadonlyArray<LegacyPullStepResult> = [
      { step: "config", status: "unchanged", written: [], detail: {} },
      { step: "migration_history", status: "unchanged", written: [], detail: {} },
      {
        step: "db",
        status: "failed",
        written: [],
        detail: {},
        failure: { message: "shadow database container failed to start" },
      },
      { step: "functions", status: "unchanged", written: [], detail: {} },
    ];
    const aggregate: LegacyPullAggregate = {
      ref: PROJECT_REF,
      branch: undefined,
      dryRun: false,
      confirmed: true,
      results,
    };
    const lines = legacyRenderPullSummary(aggregate).split("\n");
    const dbRowIndex = lines.findIndex((line) => line.startsWith("  db"));
    expect(lines[dbRowIndex + 1]!.startsWith("  functions")).toBe(true);
  });
});

describe("legacyPullConfirmMessage", () => {
  const BASE: LegacyPullConfirmMessageInput = {
    ref: PROJECT_REF,
    branch: undefined,
    configDiffText: undefined,
    willFetchMigrationHistory: false,
    migrationHistoryReason: undefined,
    dirtyPaths: [],
  };

  it("names the target project in the header line", () => {
    const message = legacyPullConfirmMessage(BASE);
    expect(message.startsWith(`Pulling from project ${PROJECT_REF}\n\n`)).toBe(true);
  });

  it("names the branch in the header line when one is set", () => {
    const message = legacyPullConfirmMessage({ ...BASE, branch: "staging" });
    expect(message.startsWith(`Pulling from project ${PROJECT_REF} (branch "staging")\n\n`)).toBe(
      true,
    );
  });

  it("reports 'no config differences' when configDiffText is undefined", () => {
    const message = legacyPullConfirmMessage(BASE);
    expect(message).toContain("No config differences found.\n\n");
  });

  it("reports 'no config differences' when configDiffText is an empty string", () => {
    const message = legacyPullConfirmMessage({ ...BASE, configDiffText: "" });
    expect(message).toContain("No config differences found.\n\n");
  });

  it("inlines a real config diff, trimming trailing whitespace, instead of the 'no differences' line", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      configDiffText: "api.max_rows [update, write]\n  local:  500\n  remote: 1000\n\n\n",
    });
    expect(message).not.toContain("No config differences found.");
    expect(message).toContain("api.max_rows [update, write]\n  local:  500\n  remote: 1000\n\n");
  });

  it("always describes the db and functions steps qualitatively, regardless of other inputs", () => {
    const message = legacyPullConfirmMessage(BASE);
    expect(message).toContain(
      "Pull the remote database schema into supabase/migrations (also updates the remote migration history table; requires Docker).",
    );
    expect(message).toContain("Download every Edge Function's source into supabase/functions.");
  });

  it("omits the migration-history line entirely when willFetchMigrationHistory is false, regardless of the reason value", () => {
    for (const migrationHistoryReason of ["flag", "bootstrap", undefined] as const) {
      const message = legacyPullConfirmMessage({
        ...BASE,
        willFetchMigrationHistory: false,
        migrationHistoryReason,
      });
      expect(message).not.toContain("Fetch the remote migration history table");
    }
  });

  it("names --with-migration-history when willFetchMigrationHistory is true for reason 'flag'", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      willFetchMigrationHistory: true,
      migrationHistoryReason: "flag",
    });
    expect(message).toContain(
      "Fetch the remote migration history table into supabase/migrations (--with-migration-history was passed).",
    );
  });

  it("adds the overwrite-disclosure line only when the migration-history fetch is due to '--with-migration-history' (reason 'flag')", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      willFetchMigrationHistory: true,
      migrationHistoryReason: "flag",
    });
    expect(message).toContain(
      "This overwrites existing files in supabase/migrations that share a name with a remote history entry.",
    );
  });

  it("omits the overwrite-disclosure line for the bootstrap case (nothing to overwrite)", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      willFetchMigrationHistory: true,
      migrationHistoryReason: "bootstrap",
    });
    expect(message).not.toContain("This overwrites existing files");
  });

  it("names the no-migration-files bootstrap case when willFetchMigrationHistory is true for reason 'bootstrap'", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      willFetchMigrationHistory: true,
      migrationHistoryReason: "bootstrap",
    });
    expect(message).toContain(
      "Fetch the remote migration history table into supabase/migrations (supabase/migrations has no migration files).",
    );
  });

  it("falls back to the bootstrap wording when willFetchMigrationHistory is true but no reason is given", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      willFetchMigrationHistory: true,
      migrationHistoryReason: undefined,
    });
    expect(message).toContain(
      "Fetch the remote migration history table into supabase/migrations (supabase/migrations has no migration files).",
    );
  });

  it("omits the dirty-tree warning when dirtyPaths is empty", () => {
    const message = legacyPullConfirmMessage({ ...BASE, dirtyPaths: [] });
    expect(message).not.toContain("uncommitted or untracked changes");
  });

  it("appends the dirty-tree warning as its own trailing block naming the one dirty path", () => {
    const message = legacyPullConfirmMessage({ ...BASE, dirtyPaths: ["supabase/config.toml"] });
    expect(message).toContain(
      "supabase/config.toml has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });

  it("uses whatever paths are given, not a hardcoded supabase/config.toml", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      dirtyPaths: ["supabase/config.json"],
    });
    expect(message).toContain(
      "supabase/config.json has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
    expect(message).not.toContain("supabase/config.toml has uncommitted");
  });

  it("names every dirty path when more than one location is dirty", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      dirtyPaths: ["supabase/config.toml", "supabase/migrations", "supabase/functions"],
    });
    expect(message).toContain(
      "supabase/config.toml, supabase/migrations, and supabase/functions have uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });

  it("orders the body config → migration_history → db → functions, and composes a config diff, a bootstrap migration-history fetch, and the dirty warning together in one message", () => {
    const message = legacyPullConfirmMessage({
      ...BASE,
      configDiffText: "api.max_rows [update, write]\n  local:  500\n  remote: 1000",
      willFetchMigrationHistory: true,
      migrationHistoryReason: "bootstrap",
      dirtyPaths: ["supabase/config.toml"],
    });
    expect(message).toBe(
      `Pulling from project ${PROJECT_REF}\n` +
        "\n" +
        "api.max_rows [update, write]\n" +
        "  local:  500\n" +
        "  remote: 1000\n" +
        "\n" +
        "Fetch the remote migration history table into supabase/migrations (supabase/migrations has no migration files).\n" +
        "Pull the remote database schema into supabase/migrations (also updates the remote migration history table; requires Docker).\n" +
        "Download every Edge Function's source into supabase/functions.\n" +
        "\n" +
        "supabase/config.toml has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.\n",
    );
  });
});

describe("legacyPullDirtyWarningMessage", () => {
  it("uses singular 'has' for exactly one dirty path", () => {
    expect(legacyPullDirtyWarningMessage(["supabase/config.toml"])).toBe(
      "supabase/config.toml has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });

  it("joins two dirty paths with 'and' and uses plural 'have'", () => {
    expect(legacyPullDirtyWarningMessage(["supabase/config.toml", "supabase/functions"])).toBe(
      "supabase/config.toml and supabase/functions have uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });

  it("joins three dirty paths with an Oxford comma and uses plural 'have'", () => {
    expect(
      legacyPullDirtyWarningMessage([
        "supabase/config.toml",
        "supabase/migrations",
        "supabase/functions",
      ]),
    ).toBe(
      "supabase/config.toml, supabase/migrations, and supabase/functions have uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
    );
  });
});
