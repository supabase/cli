import { Effect, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../shared/output/json-error-handling.ts";
import { Output } from "../shared/output/output.service.ts";
import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import { withCommandTelemetry } from "../telemetry/command-telemetry.ts";
import type { TestDbNoTestsError, TestDbRunError } from "./test-db.errors.ts";
import { testDb } from "./test-db.handler.ts";

/** Shared verbatim by both `test db` and its `db test` alias. */
export const TEST_DB_DESCRIPTION = "Tests local database with pgTAP.";
export const TEST_DB_SHORT = "Tests local database with pgTAP";

/**
 * `test db`'s entire output is the streamed pg_prove TAP on stdout. A run
 * failure (failing tests, or a run that executed none) sends its diagnostic
 * to stderr and exits 1 in json/stream-json mode instead of the default JSON
 * error handling, which would corrupt the already-streamed TAP on stdout.
 * Text mode and pre-stream errors are unaffected.
 */
const onRunFailure = (error: TestDbRunError | TestDbNoTestsError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* Effect.fail(error);
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

/**
 * Flag config shared verbatim by `supabase test db` and its hidden alias
 * `supabase db test`.
 *
 * Lives in `command-internal/` because it (with `runTestDbCommand` and
 * `testDbRuntimeLayer`) is shared across the `db` and `test` command
 * families — see "Hoist Before You Duplicate" in `apps/cli/CLAUDE.md`.
 */
export const testDbConfig = {
  paths: Argument.String("path").pipe(
    Argument.withDescription("Paths to test files or directories."),
    Argument.variadic(),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Tests the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Runs pgTAP tests on the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Runs pgTAP tests on the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export interface TestDbFlags {
  readonly paths: ReadonlyArray<string>;
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
}

/**
 * Assembled `test db` / `db test` handler: telemetry, run-failure routing
 * (`onRunFailure`), and JSON-error-handling wiring shared by both entry
 * points.
 */
export function runTestDbCommand(flags: CliCommand.Command.Config.Infer<typeof testDbConfig>) {
  return testDb({
    paths: flags.paths,
    dbUrl: flags.dbUrl,
    linked: flags.linked,
    local: flags.local,
    projectRef: flags.projectRef,
  }).pipe(
    withCommandTelemetry({
      flags: {
        "db-url": flags.dbUrl,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      },
      // No safe-flag whitelist entry for --project-ref here, so it stays redacted.
    }),
    // Run failures must not corrupt the TAP stream in machine modes; see `onRunFailure`.
    Effect.catchTag(["TestDbRunError", "TestDbNoTestsError"], onRunFailure),
    withJsonErrorHandling,
  );
}
