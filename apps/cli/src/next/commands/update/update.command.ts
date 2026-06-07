import { Layer } from "effect";
import { DEFAULT_MANAGED_STACK_NAME } from "@supabase/stack/effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../auth/platform-api.layer.ts";
import { projectLinkRemoteLayer } from "../../config/project-link-remote.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { projectLocalServiceVersionsLayer } from "../../config/project-local-service-versions.layer.ts";
import {
  discoveredCliConfigLayer,
  provideProjectCommandRuntime,
} from "../../config/project-runtime.layer.ts";
import { projectStackStateManagerLayer } from "../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { update } from "./update.handler.ts";

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
  Layer.provide(discoveredCliConfigLayer),
);

const updateRuntimeLayer = provideProjectCommandRuntime(
  Layer.mergeAll(
    projectLinkStateLayer,
    projectLocalServiceVersionsLayer,
    projectStackStateManagerLayer,
    updateProjectLinkRemoteLayer,
    commandRuntimeLayer(["stack", "update"]),
  ),
);

export const updateCommand = Command.make("update", flags).pipe(
  Command.withDescription(
    "Fetch the latest linked remote service versions when available, then update the pinned local stack versions from the linked project snapshot and CLI defaults without starting the stack.",
  ),
  Command.withShortDescription("Update pinned local stack versions"),
  Command.withExamples([
    {
      command: "supabase stack update",
      description:
        "Fetch remote linked versions and update the pinned service versions for the default local stack",
    },
  ]),
  Command.withHandler((commandFlags) =>
    update(commandFlags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(updateRuntimeLayer),
);
