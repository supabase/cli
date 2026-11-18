import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
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
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  type: cliFlag(
    "type",
    (name) => Flag.Literals(name, ["all", "security", "performance"] as const),
    {
      description: "Type of advisors to check.",
      optional: true,
      docs: { default: "all" },
    },
  ),
  level: cliFlag("level", (name) => Flag.Literals(name, ["info", "warn", "error"] as const), {
    description: "Minimum issue level to display.",
    optional: true,
    docs: { default: "warn" },
  }),
  failOn: cliFlag(
    "fail-on",
    (name) => Flag.Literals(name, ["none", "info", "warn", "error"] as const),
    {
      description: "Issue level at which the command exits with a non-zero status.",
      optional: true,
      docs: { default: "none" },
    },
  ),
} as const;

export type DbAdvisorsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbAdvisorsCommand = makeCommand("advisors", config).pipe(
  Command.withDescription(
    "Find common security and performance issues, such as missing RLS policies and unindexed foreign keys. Run it before a release or in CI.",
  ),
  Command.withShortDescription("Check a database for security and performance issues"),
  Command.withExamples([
    { command: "supabase db advisors", description: "Check the local database" },
    {
      command: "supabase db advisors --remote --type security",
      description: "Check the linked project for security issues only",
    },
    {
      command: "supabase db advisors --level error --fail-on error",
      description: "Fail a CI run when an error-level issue is found",
    },
  ]),
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
      withCondition(projectRefPicker, { dbTarget: ["linked"] }),
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
