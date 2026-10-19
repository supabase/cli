import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

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
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationSquashRuntimeLayer } from "../migration.layers.ts";
import { migrationSquash } from "./squash.handler.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  version: Flag.String("version").pipe(
    Flag.withDescription("Squash up to the specified version."),
    Flag.optional,
  ),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote. Not used for the local database or a database URL.",
  }),
} as const;

export type MigrationSquashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationSquashCommand = Command.make("squash", config).pipe(
  Command.withDescription("Squash migrations to a single file."),
  Command.withShortDescription("Squash migrations to a single file"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["version"] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    migrationSquash(flags).pipe(
      withCommandTelemetry({
        flags: {
          version: flags.version,
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
          "project-ref": flags.projectRef,
        },
        // Only `--version`'s value is recorded verbatim. `--project-ref` has no
        // established telemetry-safety baseline, so it stays redacted.
        safeFlags: ["version"],
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationSquashRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
