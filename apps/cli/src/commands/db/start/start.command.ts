import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { MigrationChecksSkipped } from "../../../command-internal/migration-checks.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbStart } from "./start.handler.ts";
import { dbStartRuntimeLayer } from "./start.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  fromBackup: Flag.String("from-backup").pipe(
    Flag.withDescription("Path to a logical backup file."),
    Flag.optional,
  ),
  skipChecks: Flag.Boolean("skip-checks").pipe(
    Flag.withDescription(
      "Skip the [db.migrations.checks] security checks when replaying local migrations.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export type DbStartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbStartCommand = Command.make("start", config).pipe(
  Command.withDescription("Starts local Postgres database."),
  Command.withShortDescription("Starts local Postgres database"),
  withPermissions({ operations: [], noApiEffectFlags: ["from-backup", "skip-checks"] }),
  Command.withHandler((flags) =>
    dbStart(flags).pipe(
      Effect.provideService(MigrationChecksSkipped, flags.skipChecks),
      withCommandTelemetry({
        // `--from-backup` is not telemetry-safe, so a set value reaches
        // telemetry as `<redacted>`.
        flags: { "from-backup": flags.fromBackup, "skip-checks": flags.skipChecks },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbStartRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
