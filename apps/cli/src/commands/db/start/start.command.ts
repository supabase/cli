import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbStart } from "./start.handler.ts";
import { dbStartRuntimeLayer } from "./start.layers.ts";

const config = {
  fromBackup: Flag.string("from-backup").pipe(
    Flag.withDescription("Path to a logical backup file."),
    Flag.optional,
  ),
} as const;

export type DbStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbStartCommand = Command.make("start", config).pipe(
  Command.withDescription("Starts local Postgres database."),
  Command.withShortDescription("Starts local Postgres database"),
  Command.withHandler((flags) =>
    dbStart(flags).pipe(
      withCommandTelemetry({
        // `--from-backup` is not telemetry-safe, so a set value reaches
        // telemetry as `<redacted>`.
        flags: { "from-backup": flags.fromBackup },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbStartRuntimeLayer),
);
