import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { dbAdvisors } from "./advisors.handler.ts";
import { dbAdvisorsRuntimeLayer } from "./advisors.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  type: Flag.Literals("type", ["all", "security", "performance"] as const).pipe(
    Flag.withDescription("Type of advisors to check: all, security, performance."),
    Flag.optional,
  ),
  level: Flag.Literals("level", ["info", "warn", "error"] as const).pipe(
    Flag.withDescription("Minimum issue level to display: info, warn, error."),
    Flag.optional,
  ),
  failOn: Flag.Literals("fail-on", ["none", "info", "warn", "error"] as const).pipe(
    Flag.withDescription("Issue level to exit with non-zero status: none, info, warn, error."),
    Flag.optional,
  ),
} as const;

export type DbAdvisorsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbAdvisorsCommand = Command.make("advisors", config).pipe(
  Command.withDescription("Checks database for security and performance issues."),
  Command.withShortDescription("Checks database for security and performance issues"),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-get-security-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", oneOf: ["all", "security"] }],
          },
          {
            operationId: "v1-get-security-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", present: false }],
          },
          {
            operationId: "v1-get-performance-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", oneOf: ["all", "performance"] }],
          },
          {
            operationId: "v1-get-performance-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", present: false }],
          },
        ],
        noApiEffectFlags: ["level", "fail-on"],
      },
      dbConfig,
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    dbAdvisors(flags).pipe(
      withCommandTelemetry({
        flags: {
          type: flags.type,
          level: flags.level,
          "fail-on": flags.failOn,
        },
        // type/level/fail-on are auto-detected as safe via `config` below.
        config,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbAdvisorsRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "its transaction is always rolled back",
  }),
);
