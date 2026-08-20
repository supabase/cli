import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigDiff } from "./diff.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Branch name, branch ID, or project ref to compare against. Mutually exclusive with --project-ref.",
    ),
    Flag.optional,
  ),
  exitCode: Flag.boolean("exit-code").pipe(
    Flag.withDescription("Exit with status 1 when any difference is found."),
  ),
} as const;

export type LegacyConfigDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyConfigDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription(
    "Shows configuration differences between supabase/config.toml and a remote project or branch. Read-only: never modifies local or remote configuration.",
  ),
  Command.withShortDescription("Diff local config against a remote project"),
  Command.withExamples([
    {
      command: "supabase config diff",
      description: "Diff against the linked project",
    },
    {
      command: "supabase config diff --target staging --exit-code",
      description: "Diff against the 'staging' branch, exiting 1 on drift",
    },
  ]),
  Command.withHandler((flags) =>
    legacyConfigDiff(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["config", "diff"])),
);
