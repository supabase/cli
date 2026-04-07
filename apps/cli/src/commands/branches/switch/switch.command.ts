import { Effect, Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiClientLayer } from "../../../auth/platform-api-client.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { projectStackStateManagerLayer } from "../../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../../output/json-error-handling.ts";
import { withCommandAnalytics } from "../../../telemetry/command-analytics.ts";
import { switchBranch } from "./switch.handler.ts";

const branchesPlatformApiLayer = platformApiClientLayer.pipe(Layer.provide(credentialsLayer));
const branchesRuntimeLayer = Layer.mergeAll(
  branchesPlatformApiLayer,
  projectLinkStateLayer,
  projectStackStateManagerLayer,
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
    switchBranch(args).pipe(
      Effect.withSpan("command.branches.switch"),
      withCommandAnalytics({ command: "branches switch" }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(branchesRuntimeLayer),
);
