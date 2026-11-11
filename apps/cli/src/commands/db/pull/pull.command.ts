import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withDocs } from "../../../docs/command-docs.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig, dbConfigPoolerFallback } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { removedFlag } from "../../../command-internal/removed-command.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import body from "./pull.docs.md" with { type: "text" };
import { dbPull, resolveRemovedExperimental } from "./pull.handler.ts";
import { dbPullRuntimeLayer } from "./pull.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  name: cliArgument("migration name", Argument.String, {
    description: "Name for the new migration file.",
    optional: true,
  }),
  // Mutually exclusive with `--diff-engine`. Optional so the mutex tracks whether the flag was
  // passed.
  declarative: cliFlag("declarative", Flag.Boolean, {
    description:
      "Replace the declarative schema files with the schema of the selected database instead of creating a migration.",
    optional: true,
  }),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error; bound to its config key because `db diff` owns the same name.
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Removed: use --declarative instead.",
    hidden: true,
  }),
  // The default follows `[experimental.pgdelta] enabled`, so it is documented, not parsed.
  diffEngine: cliFlag(
    "diff-engine",
    (name) => Flag.Literals(name, ["migra", "pg-delta"] as const),
    {
      description: "Diff engine to use when creating a migration.",
      optional: true,
      docs: { default: "pg-delta" },
    },
  ),
  strictCoverage: cliFlag("strict-coverage", Flag.Boolean, {
    description:
      "Fail when pg-delta finds schema objects it cannot manage, instead of leaving them unmanaged.",
    default: false,
  }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the project selected with --remote; ignored for the local database and database URLs.",
  }),
} as const;

export type DbPullFlags = CliCommand.Command.Config.Infer<typeof config>;

const DECLARATIVE_SUGGESTION =
  "Use --declarative to pull the declarative schema. The diff engine is chosen with --diff-engine or experimental.pgdelta.enabled in the config file.";

const EXPERIMENTAL_SUGGESTION =
  "Use --declarative to pull per-object schema files, or pass --experimental=false (or unset SUPABASE_EXPERIMENTAL) for a migration pull.";

// Rejected on a credential-free runtime: `dbPullRuntimeLayer` loads the profile and command
// settings eagerly, so building it first could fail before the removal message.
const removedFlagLayer = Layer.mergeAll(commandRuntimeLayer(["db", "pull"]), telemetryStateLayer);

const telemetryOptions = (flags: DbPullFlags) => ({
  flags: {
    declarative: flags.declarative,
    "use-pg-delta": flags.usePgDelta,
    "diff-engine": flags.diffEngine,
    "strict-coverage": flags.strictCoverage,
    schema: flags.schema,
    // `password` is a credential — always reaches telemetry as `<redacted>`.
    password: flags.password,
  },
  aliases: { s: "schema", p: "password" },
  config,
});

export const dbPullCommand = makeCommand("pull", config).pipe(
  Command.withDescription(
    "Migration mode compares supabase/migrations with the selected live database (the local database by default, or the one --remote selects), writes the complete difference as migration files, and records them in that database's migration history; a hosted database asks for confirmation first, or needs --yes in a non-interactive run. --declarative instead replaces the declarative schema tree and does not create migrations or update migration history.",
  ),
  Command.withShortDescription("Pull schema from a database"),
  withDocs({
    category: "database",
    body,
    examples: [
      {
        id: "basic-usage",
        name: "Basic usage",
        code: "supabase db pull --remote",
        response: `Target: project My Project (abcdefghijklmnopqrst) · production
◇  Update the remote migration history table on project My Project (abcdefghijklmnopqrst) · production?
│  Yes
Schema written to supabase/migrations/20240414044403_remote_schema.sql
Repaired migration history: [20240414044403] => applied
Finished supabase db pull.
`,
      },
      {
        id: "local-studio",
        name: "Local studio",
        code: "supabase db pull",
        response: `Target: local stack (127.0.0.1:54322)
Creating shadow database...
Seeding globals from roles.sql...
Applying migration 20240414044403_remote_schema.sql...
Diffing schemas...
No schema changes found
The remote database is already in sync with your local migrations — nothing to pull.
`,
      },
      {
        id: "custom-schemas",
        name: "Custom schemas",
        code: "supabase db pull --schema public,extensions --remote",
        response: `Target: project My Project (abcdefghijklmnopqrst) · production
Creating shadow database...
Seeding globals from roles.sql...
Applying migration 20240414044403_remote_schema.sql...
Diffing schemas: public,extensions
No schema changes found
The remote database is already in sync with your local migrations — nothing to pull.
`,
      },
    ],
  }),
  withPermissions(
    compose(
      {
        operations: [],
        noApiEffectFlags: [
          "declarative",
          "use-pg-delta",
          "diff-engine",
          "strict-coverage",
          "schema",
        ],
      },
      dbConfig,
      dbConfigPoolerFallback,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) => {
    const rejectRemoved = <E, R>(rejection: Effect.Effect<never, E, R>) =>
      rejection.pipe(
        withCommandTelemetry(telemetryOptions(flags)),
        withJsonErrorHandling,
        Effect.provide(removedFlagLayer),
      );

    if (Option.isSome(flags.usePgDelta)) {
      return rejectRemoved(removedFlag("--use-pg-delta", DECLARATIVE_SUGGESTION));
    }
    return resolveRemovedExperimental(flags).pipe(
      Effect.matchEffect({
        onFailure: (error) => rejectRemoved(Effect.fail(error)),
        onSuccess: ({ experimental, projectEnv }) =>
          experimental
            ? rejectRemoved(
                removedFlag(
                  "The --experimental structured-dump mode of db pull",
                  EXPERIMENTAL_SUGGESTION,
                ),
              )
            : dbPull(flags, projectEnv).pipe(
                withCommandTelemetry(telemetryOptions(flags)),
                withJsonErrorHandling,
                Effect.provide(dbPullRuntimeLayer),
              ),
      }),
    );
  }),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
