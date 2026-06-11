import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LegacyTestDbRunError } from "./db.errors.ts";
import { legacyTestDb } from "./db.handler.ts";
import { legacyTestDbRuntimeLayer } from "../test.layers.ts";

/**
 * `test db` has no machine-format envelope: its entire output is the streamed
 * pg_prove TAP on stdout (Go has no `--output-format` for it). On a *run* failure
 * (failing tests), the default `withJsonErrorHandling` would append a JSON error
 * object to stdout — after the TAP already streamed — corrupting machine consumers.
 * So in json/stream-json mode, send the diagnostic to stderr and exit 1 instead,
 * matching Go's `recoverAndExit` (stderr, exit 1). Text mode keeps the normal error
 * rendering; pre-stream errors still flow through `withJsonErrorHandling`.
 */
const onRunFailure = (error: LegacyTestDbRunError) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* Effect.fail(error);
    const processControl = yield* ProcessControl;
    yield* output.raw(`${error.message}\n`, "stderr");
    yield* processControl.setExitCode(1);
  });

const config = {
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
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Runs pgTAP tests on the local database."),
  ),
} as const;

export interface LegacyTestDbFlags {
  readonly paths: ReadonlyArray<string>;
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
}

export const legacyTestDbCommand = Command.make("db", config).pipe(
  Command.withDescription("Run pgTAP tests on the local or linked database."),
  Command.withShortDescription("Run pgTAP tests"),
  Command.withHandler((flags: CliCommand.Command.Config.Infer<typeof config>) =>
    legacyTestDb({
      paths: flags.paths,
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
    }).pipe(
      withLegacyCommandInstrumentation({
        flags: { "db-url": flags.dbUrl, linked: flags.linked, local: flags.local },
      }),
      // Run failures (failing tests) must not corrupt the TAP stream on stdout in
      // machine modes; other errors (pre-stream) still get the JSON envelope.
      Effect.catchTag("LegacyTestDbRunError", onRunFailure),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyTestDbRuntimeLayer),
);
