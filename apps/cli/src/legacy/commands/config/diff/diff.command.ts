import { Option } from "effect";
import type * as CliCommand from "effect/unstable/cli/Command";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/legacy-project-ref.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigDiff } from "./diff.handler.ts";

const config = {
  // `link`'s settled vocabulary (CLI-2167): one flag that accepts either a
  // project ref or a branch of the linked project — no separate `--target`.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
  exitCode: Flag.boolean("exit-code").pipe(
    Flag.withDescription(
      "Exit with status 2 when any difference is found (errors keep exiting 1).",
    ),
    // Without an explicit default a boolean flag is REQUIRED by the parser,
    // making plain `supabase config diff` fail with `required flag(s)
    // "exit-code" not set` — pinned by diff.e2e.test.ts, since integration
    // tests hand the handler a pre-built flags object and never parse.
    Flag.withDefault(false),
  ),
} as const;

export type LegacyConfigDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring
// `Command.withHandler` uses below (same precedent as `legacyConfigPushHandler`).
export const legacyConfigDiffHandler = (flags: LegacyConfigDiffFlags) =>
  legacyConfigDiff(flags).pipe(
    // `--project-ref` accepts branch names here (CLI-2167 vocabulary), so
    // its value is only safe to log verbatim when it is actually ref-shaped
    // — a user-created branch name must never reach PostHog. Same guard as
    // `link`.
    withLegacyCommandInstrumentation({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

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
      command: "supabase config diff --project-ref staging --exit-code",
      description: "Diff against the 'staging' branch, exiting 2 on drift",
    },
  ]),
  Command.withHandler(legacyConfigDiffHandler),
  Command.provide(legacyManagementApiRuntimeLayer(["config", "diff"])),
);
