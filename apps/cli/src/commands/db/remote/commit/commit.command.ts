import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../../command-internal/schema-flags.ts";
import { dbSchemaPullRuntimeLayer } from "../../pull/pull.layers.ts";
import { dbRemoteCommit } from "./commit.handler.ts";

const config = {
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Connect using the specified Postgres URL (must be percent-encoded)."),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Connect to the linked project."),
    Flag.withDefault(false),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type DbRemoteCommitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbRemoteCommitCommand = Command.make("commit", config).pipe(
  Command.withDescription(
    "Deprecated: use db pull instead. Commit remote changes as a new migration.",
  ),
  Command.withShortDescription("Commit remote changes as a new migration"),
  Command.withHandler((flags) =>
    dbRemoteCommit(flags).pipe(
      withCommandTelemetry({
        flags: {
          schema: flags.schema,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          password: flags.password,
        },
        aliases: { s: "schema", p: "password" },
        config,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbSchemaPullRuntimeLayer(["db", "remote", "commit"])),
);
