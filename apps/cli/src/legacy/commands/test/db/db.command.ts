import { Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTestDb } from "./db.handler.ts";
import { legacyTestDbRuntimeLayer } from "../test.layers.ts";

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
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyTestDbRuntimeLayer),
);
