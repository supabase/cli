import { Effect, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { withLegacyCommandInstrumentation } from "../telemetry/legacy-command-instrumentation.ts";
import type { LegacyTestDbNoTestsError, LegacyTestDbRunError } from "./legacy-test-db.errors.ts";
import { legacyTestDb } from "./legacy-test-db.handler.ts";

/**
 * Short/description text shared verbatim by both Go-parity entry points
 * (`legacy/commands/test/db/db.command.ts`, `legacy/commands/db/test/test.command.ts`),
 * mirroring Go's own single-source (`cmd/test.go:19`: `Short: dbTestCmd.Short`).
 * Byte-matches Go's Short text (`cmd/db.go:425`).
 */
export const LEGACY_TEST_DB_DESCRIPTION = "Tests local database with pgTAP.";
export const LEGACY_TEST_DB_SHORT = "Tests local database with pgTAP";

/**
 * `test db` has no machine-format envelope: its entire output is the streamed
 * pg_prove TAP on stdout (Go has no `--output-format` for it). On a *run* failure
 * (failing tests, or a run that executed none), the default `withJsonErrorHandling`
 * would append a JSON error object to stdout — after the TAP already streamed —
 * corrupting machine consumers.
 * So in json/stream-json mode, send the diagnostic to stderr and exit 1 instead,
 * matching Go's `recoverAndExit` (stderr, exit 1). Text mode keeps the normal error
 * rendering; pre-stream errors still flow through `withJsonErrorHandling`.
 */
const onRunFailure = (error: LegacyTestDbRunError | LegacyTestDbNoTestsError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* error;
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

/**
 * Flag config shared verbatim by `supabase test db`
 * (`legacy/commands/test/db/db.command.ts`) and its hidden Go-parity alias
 * `supabase db test` (`legacy/commands/db/test/test.command.ts`). Go registers
 * an independent-but-identical flag set on each `cobra.Command` (`cmd/db.go:
 * 736-740`, `cmd/test.go:40-44`: same names, defaults, descriptions, and
 * `MarkFlagsMutuallyExclusive` group); the TS port reuses a single object
 * instead of declaring it twice.
 *
 * Lives in `legacy/shared/` (not either command's own directory) because it —
 * along with `legacyRunTestDbCommand` below and `legacyTestDbRuntimeLayer`
 * (`./legacy-test-db.layers.ts`) — is consumed by TWO different top-level
 * command families (`db` and `test`); `code-structure.unit.test.ts` mechanically
 * forbids one `legacy/commands/<family>/` file from importing another family's
 * internals, so anything genuinely shared across families must live outside
 * `legacy/commands/` entirely (CLAUDE.md's "Hoist Before You Duplicate" rule,
 * CLI-1962).
 */
export const legacyTestDbConfig = {
  paths: Argument.string("path").pipe(
    Argument.withDescription("Paths to test files or directories."),
    Argument.variadic(),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Tests the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Runs pgTAP tests on the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Runs pgTAP tests on the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export interface LegacyTestDbFlags {
  readonly paths: ReadonlyArray<string>;
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
}

/**
 * Assembled `test db` / `db test` handler: telemetry, run-failure routing
 * (`onRunFailure`), and JSON-error-handling wiring shared verbatim by both
 * Go-parity entry points — mirroring `cmd/test.go:19-20`'s
 * `RunE: dbTestCmd.RunE`, which literally reuses the other command's handler
 * rather than re-implementing it.
 */
export function legacyRunTestDbCommand(
  flags: CliCommand.Command.Config.Infer<typeof legacyTestDbConfig>,
) {
  return legacyTestDb({
    paths: flags.paths,
    dbUrl: flags.dbUrl,
    linked: flags.linked,
    local: flags.local,
    projectRef: flags.projectRef,
  }).pipe(
    withLegacyCommandInstrumentation({
      flags: {
        "db-url": flags.dbUrl,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      },
      // TS-only flag with no Go telemetry-safety baseline; Go's nearest
      // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
      // others) are unmarked, so it stays redacted.
    }),
    // Run failures (failing tests, or a run that executed none) must not corrupt the
    // TAP stream on stdout in machine modes; other errors (pre-stream) still get the
    // JSON envelope.
    Effect.catchTag(["LegacyTestDbRunError", "LegacyTestDbNoTestsError"], onRunFailure),
    withJsonErrorHandling,
  );
}
