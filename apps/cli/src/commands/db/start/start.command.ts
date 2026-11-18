import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbStart } from "./start.handler.ts";
import { dbStartRuntimeLayer } from "./start.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  fromBackup: cliFlag("from-backup", Flag.String, {
    description: "Path to a logical backup file to restore from.",
    optional: true,
  }),
} as const;

export type DbStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbStartCommand = makeCommand("start", config).pipe(
  Command.withDescription(
    "Start only the local Postgres container, without the rest of the Supabase stack. Use it when you just need a local database, for example to run migrations.",
  ),
  Command.withShortDescription("Start the local Postgres database"),
  Command.withExamples([
    { command: "supabase db start", description: "Start the local Postgres database" },
    {
      command: "supabase db start --from-backup ./backup.sql",
      description: "Start the database and restore it from a logical backup",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["from-backup"] }),
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
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
