import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { dbLint } from "./lint.handler.ts";
import { dbLintRuntimeLayer } from "./lint.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  level: cliFlag("level", (name) => Flag.Literals(name, ["warning", "error"] as const), {
    description: "Minimum lint level to report.",
    optional: true,
    docs: { default: "warning" },
  }),
  failOn: cliFlag("fail-on", (name) => Flag.Literals(name, ["none", "warning", "error"] as const), {
    description: "Lint level at which the command exits with a non-zero status.",
    optional: true,
    docs: { default: "none" },
  }),
} as const;

export type DbLintFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbLintCommand = makeCommand("lint", config).pipe(
  Command.withDescription(
    "Find errors in your database functions by running the plpgsql_check extension against the selected database.",
  ),
  Command.withShortDescription("Check a database for schema errors"),
  withPermissions(
    compose(
      { operations: [], noApiEffectFlags: ["schema", "level", "fail-on"] },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    dbLint(flags).pipe(
      withCommandTelemetry({
        flags: {
          schema: flags.schema,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // level/fail-on are auto-detected as safe (Flag.Literals); --schema stays redacted (no
        // established safelist).
        config,
        aliases: { s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbLintRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "its transaction is always rolled back",
  }),
);
