import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiClientLayer } from "../../../auth/platform-api-client.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../output/json-error-handling.ts";
import { withCommandAnalytics } from "../../../telemetry/command-analytics.ts";
import { list } from "./list.handler.ts";

const branchesPlatformApiLayer = platformApiClientLayer.pipe(Layer.provide(credentialsLayer));
const branchesRuntimeLayer = Layer.mergeAll(branchesPlatformApiLayer, projectLinkStateLayer);

export const listBranchesCommand = Command.make("list").pipe(
  Command.withDescription(
    "List all remote branches for the linked project.\n\n" +
      "Requires the project to be linked (`supabase link`). " +
      "Marks the currently active branch with `>` in text output.",
  ),
  Command.withShortDescription("List remote branches for the linked project"),
  Command.withExamples([
    {
      command: "supabase branches list",
      description: "List branches for the linked project",
    },
    {
      command: "supabase branches list --output-format json",
      description: "Machine-readable output with an `active` field per branch",
    },
  ]),
  Command.withHandler(() =>
    list().pipe(
      Effect.withSpan("command.branches.list"),
      withCommandAnalytics({ command: "branches list" }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(branchesRuntimeLayer),
);
