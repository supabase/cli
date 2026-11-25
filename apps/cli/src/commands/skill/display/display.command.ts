import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withSidebar } from "../../../command-internal/command-sidebar.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { topicSlugs } from "../content/topics.ts";
import { skillDisplay } from "./display.handler.ts";

const config = {
  topic: Argument.String("topic").pipe(
    Argument.withDescription(
      `Topic to print; omit for the overview. Topics: ${topicSlugs.join(", ")}.`,
    ),
    Argument.optional,
  ),
} as const;

export type SkillDisplayFlags = CliCommand.Command.Config.Infer<typeof config>;

export const skillDisplayHandler = (flags: SkillDisplayFlags) =>
  skillDisplay(flags).pipe(
    withCommandTelemetry({ flags, outputFormats: GLOBAL_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const skillDisplayCommand = Command.make("display", config).pipe(
  withSidebar({ title: "Print agent guidance" }),
  Command.withDescription(
    "Print agent guidance for the installed CLI version as markdown. The output is always raw markdown; --output-format does not change it.",
  ),
  Command.withShortDescription("Print agent guidance for this CLI version"),
  Command.withExamples([
    { command: "supabase skill display", description: "Print the overview and topic list" },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler(skillDisplayHandler),
  Command.provide(commandRuntimeLayer(["skill", "display"])),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
