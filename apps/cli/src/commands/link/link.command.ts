import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiClientLayer } from "../../auth/platform-api-client.layer.ts";
import { projectLinkRemoteLayer } from "../../config/project-link-remote.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { link } from "./link.handler.ts";

const flags = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LinkFlags = CliCommand.Command.Config.Infer<typeof flags>;

const linkPlatformApiLayer = platformApiClientLayer.pipe(Layer.provide(credentialsLayer));
const linkProjectLinkRemoteLayer = projectLinkRemoteLayer.pipe(Layer.provide(linkPlatformApiLayer));

const linkRuntimeLayer = Layer.mergeAll(linkProjectLinkRemoteLayer, projectLinkStateLayer);

export const linkCommand = Command.make("link", flags).pipe(
  Command.withDescription(
    "Link the current local Supabase project to a hosted Supabase project.\n\n" +
      "Stores the linked project ref and cached remote service versions in .supabase/project.json so local startup can match the hosted platform versions.",
  ),
  Command.withShortDescription("Link local project to Supabase"),
  Command.withExamples([
    {
      command: "supabase link",
      description: "Pick a project interactively and cache its platform versions",
    },
    {
      command: "supabase link --project-ref abcdefghijklmnopqrst",
      description: "Link directly to a specific project ref",
    },
  ]),
  Command.withHandler((flags) =>
    link(flags).pipe(Effect.withSpan("command.link"), withJsonErrorHandling),
  ),
  Command.provide(linkRuntimeLayer),
);
