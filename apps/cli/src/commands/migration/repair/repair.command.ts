import { Argument, Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationRepair } from "./repair.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  versions: Argument.String("version").pipe(
    Argument.withDescription("Migration version(s) to repair."),
    Argument.variadic(),
  ),
  status: Flag.Literals("status", ["applied", "reverted"] as const).pipe(
    Flag.withDescription("Version status to update."),
  ),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the linked project (--linked/--project-ref). Not used with --local or --db-url.",
  }),
} as const;

export const migrationRepairCommand = Command.make("repair", config).pipe(
  Command.withDescription("Repair the migration history table."),
  Command.withShortDescription("Repair the migration history table"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["status"] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
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
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // --status is auto-detected as safe via config below; password and
        // --project-ref stay redacted.
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
