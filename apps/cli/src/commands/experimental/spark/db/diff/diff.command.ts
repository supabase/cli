import { Command, Flag } from "effect/cli";

import { cliConfigValuesLayer } from "../../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../../config/cli-config-flags.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkDbDiff } from "./diff.handler.ts";
import {
  schema,
  shadowRuntimeLayer,
  sparkTargetFlags,
  withSparkTargetHelp,
} from "../../spark.flags.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";

const diffConfig = {
  ...sparkTargetFlags(),
  schema,
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves the schema diff as a new migration with this name."),
    Flag.optional,
  ),
} as const;

export const sparkDbDiffCommand = Command.make("diff", diffConfig).pipe(
  Command.withDescription(
    "Plans supabase/schemas against the project's dump in a shadow Postgres, then dry-runs the migration on Spark. Statements Spark refuses are reported and nothing is written.",
  ),
  Command.withShortDescription("Diffs the schema files against the Spark project"),
  Command.withHandler((flags) =>
    sparkDbDiff(flags).pipe(
      withCommandTelemetry({
        flags: { file: flags.file, schema: flags.schema },
        aliases: { f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(shadowRuntimeLayer(["db", "diff"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(diffConfig),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the target and writes only local migration files",
  }),
  withSparkTargetHelp,
);
