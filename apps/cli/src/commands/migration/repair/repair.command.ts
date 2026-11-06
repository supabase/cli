import { Argument, Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationRepair } from "./repair.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  versions: cliArgument("version", repeated(Argument.String), {
    description: "Migration versions to mark with the given status.",
  }),
  status: cliFlag("status", (name) => Flag.Literals(name, ["applied", "reverted"] as const), {
    description: "Status to record for the given migration versions.",
    required: true,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

export const migrationRepairCommand = makeCommand("repair", config).pipe(
  Command.withDescription(
    "Mark migrations as applied or reverted in the migration history table, without running them. Use it when the local files and the history of a database are out of sync.",
  ),
  Command.withShortDescription("Repair the migration history"),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["status"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    migrationRepair({
      versions: flags.versions.map(String),
      status: flags.status,
      remote: flags.remote,
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
      projectRef: flags.projectRef,
      password: flags.password,
    }).pipe(
      withCommandTelemetry({
        flags: {
          status: flags.status,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // --status is auto-detected as safe via config below; password stays redacted.
        config,
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "repair"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
