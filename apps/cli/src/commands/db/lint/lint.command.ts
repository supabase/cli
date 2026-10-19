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
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { dbLint } from "./lint.handler.ts";
import { dbLintRuntimeLayer } from "./lint.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  level: Flag.Literals("level", ["warning", "error"] as const).pipe(
    Flag.withDescription("Error level to emit."),
    Flag.optional,
  ),
  failOn: Flag.Literals("fail-on", ["none", "warning", "error"] as const).pipe(
    Flag.withDescription("Error level to exit with non-zero status."),
    Flag.optional,
  ),
} as const;

export type DbLintFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbLintCommand = Command.make("lint", config).pipe(
  Command.withDescription("Checks local database for typing error."),
  Command.withShortDescription("Checks local database for typing error"),
  withPermissions(
    withDbTarget(
      compose(
        { operations: [], noApiEffectFlags: ["schema", "level", "fail-on"] },
        dbConfig,
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    dbLint(flags).pipe(
      withCommandTelemetry({
        flags: {
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          schema: flags.schema,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // level/fail-on are auto-detected as safe (Flag.Literals); --schema and
        // --project-ref stay redacted (no established safelist).
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
