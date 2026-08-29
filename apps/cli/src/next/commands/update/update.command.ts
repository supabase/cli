import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../auth/platform-api.layer.ts";
import { projectLinkRemoteLayer } from "../../config/project-link-remote.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import {
  discoveredCliSettingsLayer,
  provideCliProjectCommandRuntime,
} from "../../config/project-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { update } from "./update.handler.ts";
import { DEFAULT_MANAGED_STACK_NAME } from "../../../shared/stack-constants.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
} as const;

export type UpdateFlags = CliCommand.Command.Config.Infer<typeof flags>;

const updatePlatformApiLayer = platformApiLayer.pipe(Layer.provide(credentialsLayer));
const updateProjectLinkRemoteLayer = projectLinkRemoteLayer.pipe(
  Layer.provide(updatePlatformApiLayer),
  Layer.provide(discoveredCliSettingsLayer),
);

const updateRuntimeLayer = provideCliProjectCommandRuntime(
  Layer.mergeAll(
    projectLinkStateLayer,
    updateProjectLinkRemoteLayer,
    commandRuntimeLayer(["stack", "update"]),
  ),
);

export const updateCommand = Command.make("update", flags).pipe(
  Command.withDescription(
    "Refresh the linked project metadata used by local stack commands without starting the stack.",
  ),
  Command.withShortDescription("Refresh linked project metadata"),
  Command.withExamples([
    {
      command: "supabase stack update",
      description: "Refresh linked project metadata for the default local stack",
    },
  ]),
  Command.withHandler((commandFlags) =>
    update(commandFlags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(updateRuntimeLayer),
);
