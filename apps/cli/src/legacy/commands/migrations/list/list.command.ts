import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsList } from "./list.handler.ts";

const config = {
  against: Flag.string("against").pipe(
    Flag.withDescription("Target to compare: local, linked, or a connection string."),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsListCommand = Command.make("list", config).pipe(
  Command.withDescription("Compare local migration files with target migration history."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) =>
    legacyMigrationsList(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "list"])),
);
