import { withSidebar } from "../../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationDbRuntimeLayer } from "../migration.layers.ts";
import { migrationList } from "./list.handler.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { STACK_SELECTOR_FLAGS } from "../../../command-internal/stack-target.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote. Not used for the local database or a database URL.",
  }),
} as const;

export type MigrationListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationListCommand = Command.make("list", config).pipe(
  withSidebar({ title: "List all migrations" }),
  Command.withDescription(
    "List local migration files and the migration history of the target database.",
  ),
  Command.withShortDescription("List local files and the target database's migration history"),
  Command.withHandler((flags) =>
    migrationList(flags).pipe(
      withCommandTelemetry({
        flags: {
          // `password` is a credential — always reaches telemetry as `<redacted>`.
          password: flags.password,
        },
        // `p` maps to the already-redacted `password` flag.
        aliases: { p: "password" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(migrationDbRuntimeLayer(["migration", "list"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
  Command.withGlobalFlags(STACK_SELECTOR_FLAGS),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: [] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
);
