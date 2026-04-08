import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../auth/platform-api.layer.ts";
import { projectLinkRemoteLayer } from "../../config/project-link-remote.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { link } from "./link.handler.ts";

const flags = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LinkFlags = CliCommand.Command.Config.Infer<typeof flags>;

const linkPlatformApiLayer = platformApiLayer.pipe(Layer.provide(credentialsLayer));
const linkProjectLinkRemoteLayer = projectLinkRemoteLayer.pipe(Layer.provide(linkPlatformApiLayer));

const linkRuntimeLayer = Layer.mergeAll(
  linkProjectLinkRemoteLayer,
  projectLinkStateLayer,
  commandRuntimeLayer(["link"]),
);

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
    link(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(linkRuntimeLayer),
);
