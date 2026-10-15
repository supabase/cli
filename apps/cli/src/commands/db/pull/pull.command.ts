import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
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
import { dbPull, resolveRemovedExperimental } from "./pull.handler.ts";
import { dbPullRuntimeLayer } from "./pull.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  name: Argument.String("migration name").pipe(
    Argument.withDescription("Optional name for the migration file."),
    Argument.optional,
  ),
  // Mutually exclusive with `--diff-engine`. Optional so the mutex tracks whether the flag was
  // passed.
  declarative: Flag.Boolean("declarative").pipe(
    Flag.withDescription(
      "Replace the declarative schema tree from the selected database instead of creating a migration; migration history is not updated.",
    ),
    Flag.optional,
  ),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error; bound to its config key because `db diff` owns the same name.
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Removed: use --declarative instead.",
    hidden: true,
  }),
  diffEngine: Flag.Literals("diff-engine", ["migra", "pg-delta"] as const).pipe(
    Flag.withDescription("Diff engine to use for migration-style db pull."),
    Flag.optional,
  ),
  strictCoverage: Flag.Boolean("strict-coverage").pipe(
    Flag.withDescription(
      "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
    ),
    Flag.withDefault(false),
  ),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  ...targetFlags({ group: "sync", subject: "database", dbUrl: true }),
  password: CliConfigKeys.linkedDb.password.flag({
    name: "password",
    alias: "p",
    description:
      "Database password for the linked project (--linked/--project-ref). Not used with --local or --db-url.",
  }),
} as const;

export type DbPullFlags = CliCommand.Command.Config.Infer<typeof config>;

const DECLARATIVE_SUGGESTION =
  "Use --declarative to pull the declarative schema. The diff engine is chosen with --diff-engine or [experimental.pgdelta] enabled in config.toml.";

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
    "db-url": flags.dbUrl,
    linked: flags.linked,
    local: flags.local,
    "project-ref": flags.projectRef,
    // `password` is a credential — always reaches telemetry as `<redacted>`.
    password: flags.password,
  },
  // Not on the established `--project-ref` safeFlags allowlist, so it stays redacted.
  aliases: { s: "schema", p: "password" },
  config,
});

export const dbPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Migration mode compares supabase/migrations with the selected live database (the linked project by default), writes the complete difference as migration files, and records them in that database's migration history; a hosted database asks for confirmation first, or needs --yes in a non-interactive run. --declarative instead replaces the declarative schema tree and does not create migrations or update migration history.",
  ),
  Command.withShortDescription("Pull schema from the remote database"),
  withPermissions(
    withDbTarget(
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
      ),
      { default: "linked" },
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
  withTargetPolicy({ group: "sync", consent: "no" }),
);
