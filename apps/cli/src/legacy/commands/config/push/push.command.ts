import { Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { PROJECT_REF_PATTERN } from "../../../config/legacy-project-ref.service.ts";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigPush } from "./push.handler.ts";

const config = {
  // `link`'s settled vocabulary (CLI-2167/CLI-2289): one flag that accepts
  // either a project ref or a branch of the linked project — no separate
  // `--target`.
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription(
      "Project ref of the Supabase project, or the name (or UUID) of one of its branches. Values that are exactly 20 lowercase letters are always treated as project refs.",
    ),
    Flag.optional,
  ),
} as const;

export type LegacyConfigPushFlags = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring
// `Command.withHandler` uses below (same precedent as `legacyLinkHandler`).
export const legacyConfigPushHandler = (flags: LegacyConfigPushFlags) =>
  legacyConfigPush(flags).pipe(
    // Nothing validates `--project-ref` before the instrumentation fires, so
    // its value is only safe to log verbatim when it is actually ref-shaped —
    // an arbitrary string (a typo, a value pasted from the wrong clipboard)
    // must reach PostHog as "<redacted>". Same guard as `link`/`config diff`
    // (documented safe list in apps/cli/CLAUDE.md).
    withLegacyCommandInstrumentation({
      flags,
      safeFlags:
        Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
          ? ["project-ref"]
          : [],
    }),
    withJsonErrorHandling,
  );

export const legacyConfigPushCommand = Command.make("push", config).pipe(
  Command.withDescription("Pushes local config.toml to the linked project or one of its branches."),
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
  Command.withHandler(legacyConfigPushHandler),
  Command.provide(Layer.mergeAll(legacyManagementApiRuntimeLayer(["config", "push"]), stdinLayer)),
);
