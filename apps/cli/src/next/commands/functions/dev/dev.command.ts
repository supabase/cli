import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { provideCliProjectCommandRuntime } from "../../../config/project-runtime.layer.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { DEFAULT_MANAGED_STACK_NAME } from "../../../../shared/stack-constants.ts";
import { functionsDev } from "./dev.handler.ts";

const flags = {
  stack: Flag.string("stack").pipe(Flag.withDefault(DEFAULT_MANAGED_STACK_NAME)),
  envFile: Flag.string("env-file").pipe(Flag.optional),
  importMap: Flag.string("import-map").pipe(Flag.optional),
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(Flag.withDefault(false)),
} as const;
export type FunctionsDevFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const functionsDevCommand = Command.make("serve", flags).pipe(
  Command.withDescription("Serve local Edge Functions through the managed stack."),
  Command.withShortDescription("Serve Edge Functions locally"),
  Command.withHandler((flags) =>
    functionsDev(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(provideCliProjectCommandRuntime(commandRuntimeLayer(["functions", "serve"]))),
);
