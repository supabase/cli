import { Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { provideProjectCommandRuntime } from "../../../config/project-runtime.layer.ts";
import { projectStackStateManagerLayer } from "../../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { switchBranch } from "./switch.handler.ts";

const branchesPlatformApiLayer = platformApiLayer.pipe(Layer.provide(credentialsLayer));
const branchesRuntimeLayer = provideProjectCommandRuntime(
  Layer.mergeAll(
    branchesPlatformApiLayer,
    projectLinkStateLayer,
    projectStackStateManagerLayer,
    commandRuntimeLayer(["branches", "switch"]),
  ),
);

const args = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Branch name or project ref to switch to"),
    Argument.optional,
  ),
} as const;

export const switchBranchesCommand = Command.make("switch", args).pipe(
  Command.withDescription(
    "Switch the active branch for the linked project.\n\n" +
      "Requires the project to be linked (`supabase link`). " +
      "Updates local state so subsequent commands operate against the selected branch. " +
      "If no branch name is provided and the terminal is interactive, a selection prompt is shown.",
  ),
  Command.withShortDescription("Switch the active branch for the linked project"),
  Command.withExamples([
    {
      command: "supabase branches switch my-feature",
      description: "Switch to a branch by name",
    },
    {
      command: "supabase branches switch abcdefghijklmnopqrst",
      description: "Switch to a branch by project ref",
    },
    {
      command: "supabase branches switch",
      description: "Interactively select a branch to switch to",
    },
  ]),
  Command.withHandler((args) =>
    switchBranch(args).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(branchesRuntimeLayer),
);
