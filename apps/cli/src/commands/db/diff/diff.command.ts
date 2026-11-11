import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withContext,
} from "../../../command-internal/command-permissions/model.ts";
import {
  dbConfig,
  dbConfigLinked,
  dbConfigNamedProject,
} from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbDiff } from "./diff.handler.ts";
import { dbDiffRuntimeLayer } from "./diff.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  // The engine flags are a mutually-exclusive group, modelled as `Option` so the mutex check keys
  // off whether the flag was passed; engine selection uses its value.
  useMigra: cliFlag("use-migra", Flag.Boolean, {
    description: "Use the legacy migra engine to generate the schema diff.",
    optional: true,
  }),
  usePgAdmin: cliFlag("use-pgadmin", Flag.Boolean, {
    description: "Use pgAdmin to generate the schema diff.",
    optional: true,
  }),
  // Kept parsed (and hidden) only so using it produces an actionable removal error instead of
  // an unknown-flag parse error; see diff.handler.ts.
  usePgSchema: cliFlag("use-pg-schema", Flag.Boolean, {
    description: "Removed: use the default pg-delta engine or --use-migra instead.",
    optional: true,
    hidden: true,
  }),
  usePgDelta: CliConfigKeys.experimental.pgdelta.enabled.flag({
    name: "use-pg-delta",
    description: "Use pg-delta to generate the schema diff.",
  }),
  strictCoverage: cliFlag("strict-coverage", Flag.Boolean, {
    description:
      "Fail when pg-delta finds schema objects it cannot manage, instead of leaving them unmanaged.",
    default: false,
  }),
  from: cliFlag("from", Flag.String, {
    description:
      "Source of the diff: local, migrations, remote (always the linked project), a project ref, a branch, or a Postgres URL.",
    optional: true,
  }),
  to: cliFlag("to", Flag.String, {
    description:
      "Target of the diff: local, migrations, remote (always the linked project), a project ref, a branch, or a Postgres URL.",
    optional: true,
  }),
  output: cliFlag("output", Flag.String, {
    description:
      "Write the flattened diff SQL of --from and --to mode to a file for review; it is not a portable apply script.",
    alias: "o",
    optional: true,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  file: cliFlag("file", Flag.String, {
    description:
      "Save the complete schema diff as a new migration with this name; ignored with --from and --to.",
    alias: "f",
    optional: true,
  }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
} as const;

export type DbDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

// An explicit `--from`/`--to` of `remote` or the deprecated `linked` resolves the linked project.
const explicitLinkedSide = (flag: "from" | "to") =>
  withCondition(compose(dbConfigLinked, linkedProjectCache), { flag, oneOf: ["linked", "remote"] });

// Conditions can't tell a ref or branch from `local`, `migrations` or a URL; any value declares it.
const explicitNamedProjectSide = (flag: "from" | "to") =>
  withContext(
    withCondition(compose(dbConfigNamedProject, linkedProjectCache), { flag, present: true }),
    `--${flag} is a project ref or branch name, not local, migrations, remote or a URL`,
  );

const explicitBranchSide = (flag: "from" | "to") =>
  ({
    operationId: "v1-list-all-branches",
    kind: "required",
    when: [{ flag, present: true }],
    context: `--${flag} is a branch name or UUID, not local, migrations, remote, a project ref or a URL`,
  }) as const;

export const dbDiffCommand = makeCommand("diff", config).pipe(
  Command.withDescription(
    "Compare a shadow database built from supabase/migrations with a live database, the local one by default or the one --remote selects. Declarative files under supabase/schemas are not part of this baseline. Output is printed by default; -f saves the complete diff as a migration, and --from/--to output is flattened review SQL, not a portable apply script.",
  ),
  Command.withShortDescription("Diff a database for schema changes"),
  withPermissions(
    compose(
      {
        operations: [explicitBranchSide("from"), explicitBranchSide("to")],
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
      explicitNamedProjectSide("from"),
      explicitNamedProjectSide("to"),
      branchResolution,
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
          file: flags.file,
          schema: flags.schema,
        },
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
