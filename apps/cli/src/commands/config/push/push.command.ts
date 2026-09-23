import { Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { configPush } from "./push.handler.ts";

const config = {
  // Accepts either a project ref or a branch name/UUID of the linked project; there's no
  // separate --target flag.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
} as const;

export type ConfigPushFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring
// `Command.withHandler` uses below (same precedent as `linkHandler`).
export const configPushHandler = (flags: ConfigPushFlags) =>
  configPush(flags).pipe(
    // --project-ref is only safe to log verbatim when ref-shaped; an arbitrary string (a typo,
    // a bad paste) must reach PostHog as "<redacted>".
    withCommandTelemetry({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

export const configPushCommand = Command.make("push", config).pipe(
  Command.withDescription(
    "Pushes the properties your local config.toml declares to the linked project or one of its branches. Properties the file does not declare are left unchanged; run `supabase config diff` to preview. Prompts for confirmation before writing each changed resource, showing the exact diff. Non-interactive runs honor piped y/n answers and skip changes without an affirmative answer or --yes/SUPABASE_YES. Run `supabase config diff` first to review the changes.",
  ),
  Command.withShortDescription("Push local config to linked project"),
  Command.withExamples([
    {
      command: "supabase config push",
      description: "Push local config to the linked project",
    },
    {
      command: "supabase config push --project-ref abcdefghijklmnopqrst",
      description: "Push local config to a specific project",
    },
    {
      command: "supabase config push --project-ref staging",
      description: "Push local config to the 'staging' branch",
    },
  ]),
  Command.withHandler(configPushHandler),
  Command.provide(Layer.mergeAll(managementApiRuntimeLayer(["config", "push"]), stdinLayer)),
);
