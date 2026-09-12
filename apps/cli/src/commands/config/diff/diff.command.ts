import { Option } from "effect";
import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configDiff } from "./diff.handler.ts";

const config = {
  // Accepts either a project ref or a branch of the linked project; no separate `--target` flag.
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
  exitCode: Flag.Boolean("exit-code").pipe(
    Flag.withDescription(
      "Exit with status 2 when any difference is found (errors keep exiting 1).",
    ),
    // Boolean flags are required by the parser without an explicit default, which would break
    // plain `supabase config diff` with a missing-required-flag error.
    Flag.withDefault(false),
  ),
} as const;

export type ConfigDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const configDiffHandler = (flags: ConfigDiffFlags) =>
  configDiff(flags).pipe(
    // `--project-ref` also accepts branch names, so its value is safe to log only when it's
    // actually ref-shaped — a user-created branch name must never reach PostHog.
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
      // This command rejects every `-o/--output` value itself with a message pointing at
      // `--output-format`, so the wrapper must allow the full choice set through — otherwise its
      // own generic enum-check message would fire first and the handler would never run.
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const configDiffCommand = Command.make("diff", config).pipe(
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
      command: "supabase config diff --project-ref staging --exit-code",
      description: "Diff against the 'staging' branch, exiting 2 on drift",
    },
  ]),
  Command.withHandler(configDiffHandler),
  Command.provide(managementApiRuntimeLayer(["config", "diff"])),
);
