import { Layer } from "effect";
import { DEFAULT_MANAGED_STACK_NAME } from "@supabase/stack/effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { projectLocalServiceVersionsLayer } from "../../config/project-local-service-versions.layer.ts";
import { provideProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
import { projectStackStateManagerLayer } from "../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import { status } from "./status.handler.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
} as const;

export type StatusFlags = CliCommand.Command.Config.Infer<typeof flags>;

const statusRuntimeLayer = provideProjectCommandRuntime(
  Layer.mergeAll(
    projectLinkStateLayer,
    projectLocalServiceVersionsLayer,
    projectStackStateManagerLayer,
    commandRuntimeLayer(["status"]),
  ),
);

export const statusCommand = Command.make("status", flags).pipe(
  Command.withDescription("Show the current local Supabase stack status."),
  Command.withShortDescription("Show local stack connection info and service status"),
  Command.withHandler((flags) =>
    status(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(statusRuntimeLayer),
);
