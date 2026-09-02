import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { DEFAULT_MANAGED_STACK_NAME } from "../../../shared/stack-constants.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { provideCliProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { restart } from "./restart.handler.ts";
import { excludeFlag } from "../../config/stack-config.ts";

const flags = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Name of the managed local stack for this project."),
    Flag.withDefault(DEFAULT_MANAGED_STACK_NAME),
  ),
  exclude: excludeFlag,
} as const;

export type RestartFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const restartCommand = Command.make("restart", flags).pipe(
  Command.withDescription("Restart the local Supabase development stack."),
  Command.withShortDescription("Restart local Supabase stack"),
  Command.withHandler((flags) =>
    restart(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(provideCliProjectCommandRuntime(commandRuntimeLayer(["restart"]))),
);
