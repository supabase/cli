import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
import { dbConfig, dbConfigLinked } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbDiff } from "./diff.handler.ts";
import { dbDiffRuntimeLayer } from "./diff.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  // The engine flags are a mutually-exclusive group, modelled as `Option` so the mutex check keys
  // off whether the flag was passed; engine selection uses its value.
  useMigra: Flag.Boolean("use-migra").pipe(
    Flag.withDescription("Use migra to generate schema diff."),
    Flag.optional,
  ),
  usePgAdmin: Flag.Boolean("use-pgadmin").pipe(
    Flag.withDescription("Use pgAdmin to generate schema diff."),
    Flag.optional,
  ),
  // Kept parsed (and hidden) only so using it produces an actionable removal error instead of
  // an unknown-flag parse error; see diff.handler.ts.
  usePgSchema: Flag.Boolean("use-pg-schema").pipe(
    Flag.withDescription("Removed: use the default pg-delta engine or --use-migra instead."),
    Flag.optional,
    Flag.withHidden,
  ),
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Use pg-delta to generate schema diff.",
  }),
  strictCoverage: Flag.Boolean("strict-coverage").pipe(
    Flag.withDescription(
      "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
    ),
    Flag.withDefault(false),
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription(
      "Diff from local, migrations, remote, a project ref, a branch, or a Postgres URL.",
    ),
    Flag.optional,
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription(
      "Diff to local, migrations, remote, a project ref, a branch, or a Postgres URL.",
    ),
    Flag.optional,
  ),
  output: Flag.String("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription(
      "Write flattened explicit diff SQL to a file for review; this is not a portable apply script.",
    ),
    Flag.optional,
  ),
  ...targetFlags({ subject: "database", dbUrl: true }),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      "In normal mode, names and saves the complete schema diff as a new migration; it does not filter objects. Ignored with --from/--to.",
    ),
    Flag.optional,
  ),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    // `--schema`/`-s` CSV-parses each value; use the shared helper so quoted
    // commas survive and malformed CSV fails at parse time.
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
} as const;

export type DbDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

// An explicit `--from`/`--to` of `remote` or the deprecated `linked` resolves the linked project without `--remote`. A project ref, branch or URL side is not modelled: `oneOf` only matches fixed values.
const explicitLinkedSide = (flag: "from" | "to") =>
  withCondition(compose(dbConfigLinked, linkedProjectCache), { flag, oneOf: ["linked", "remote"] });

export const dbDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription(
    "Compares a shadow built from supabase/migrations with a live database (--local by default, --linked, or --db-url). Declarative files under supabase/schemas are not part of this baseline. Output is printed by default; in normal mode, -f names and saves the complete diff as a migration and does not filter objects. Explicit --from/--to output is flattened review SQL, not a portable apply script.",
  ),
  Command.withShortDescription("Diffs the local database for schema changes"),
  withPermissions(
    withDbTarget(
      compose(
        {
          operations: [],
          noApiEffectFlags: [
            "use-migra",
            "use-pgadmin",
            "use-pg-schema",
            "use-pg-delta",
            "strict-coverage",
            "output",
            "file",
            "schema",
          ],
        },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
        explicitLinkedSide("from"),
        explicitLinkedSide("to"),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    dbDiff(flags).pipe(
      withCommandTelemetry({
        flags: {
          "use-migra": flags.useMigra,
          "use-pgadmin": flags.usePgAdmin,
          "use-pg-schema": flags.usePgSchema,
          "use-pg-delta": flags.usePgDelta,
          "strict-coverage": flags.strictCoverage,
          from: flags.from,
          to: flags.to,
          output: flags.output,
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          file: flags.file,
          schema: flags.schema,
        },
        // No established telemetry-safety baseline for --project-ref, so it stays redacted.
        aliases: { o: "output", f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbDiffRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the target and writes only local migration files",
  }),
);
