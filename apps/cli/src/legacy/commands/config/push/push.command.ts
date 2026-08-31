import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigPush } from "./push.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyConfigPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyConfigPushCommand = Command.make("push", config).pipe(
  Command.withDescription("Pushes local config.toml to the linked project."),
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
  ]),
  Command.withHandler((flags) =>
    legacyConfigPush(flags).pipe(
      // Unlike `config diff`'s branch-accepting flag, push's `--project-ref`
      // is ref-only, so its value is always safe to log verbatim — keeping
      // the config family's telemetry consistent (documented safe list in
      // apps/cli/CLAUDE.md).
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(Layer.mergeAll(legacyManagementApiRuntimeLayer(["config", "push"]), stdinLayer)),
);
