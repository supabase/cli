import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { issues } from "./issues.handler.ts";
import { dbAdvisorsRuntimeLayer } from "../db/advisors/advisors.layers.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { cliConfigValuesLayer } from "../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../config/cli-config-flags.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  type: Flag.Literals("type", ["all", "security", "performance", "health"] as const).pipe(
    Flag.withDescription("Type of issues to check: all, security, performance, health."),
    Flag.optional,
  ),
  severity: Flag.Literals("severity", ["info", "warning", "critical"] as const).pipe(
    Flag.withDescription("Minimum issue severity to display: info, warning, critical."),
    Flag.optional,
  ),
  failOn: Flag.Literals("fail-on", ["none", "info", "warning", "critical"] as const).pipe(
    Flag.withDescription("Minimum displayed issue severity to exit with non-zero status."),
    Flag.optional,
  ),
} as const;

export type IssuesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const issuesCommand = Command.make("issues", config).pipe(
  Command.withDescription("Checks security, performance, and health issues."),
  Command.withShortDescription("Checks security, performance, and health issues"),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v2-run-project-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", oneOf: ["all", "health"] }],
          },
          {
            operationId: "v2-run-project-advisors",
            kind: "required",
            when: [{ dbTarget: ["linked"] }, { flag: "type", present: false }],
          },
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
        noApiEffectFlags: ["severity", "fail-on"],
      },
      withCondition(projectRefPicker, { dbTarget: ["linked"] }),
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    issues(flags).pipe(
      withCommandTelemetry({
        flags: {
          type: flags.type,
          severity: flags.severity,
          "fail-on": flags.failOn,
        },
        config,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["issues"])),
  Command.provide(dbAdvisorsRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "its transaction is always rolled back",
  }),
);
