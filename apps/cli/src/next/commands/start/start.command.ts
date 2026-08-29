import { Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { DEFAULT_MANAGED_STACK_NAME } from "../../../shared/stack-constants.ts";
import { provideCliProjectCommandRuntime } from "../../config/project-runtime.layer.ts";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { inkLayer } from "../../../shared/runtime/ink.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { start } from "./start.handler.ts";

export const excludedStackServices = [
  "auth",
  "realtime",
  "storage",
  "studio",
  "analytics",
  "pooler",
] as const;
export type ExcludedStackService = (typeof excludedStackServices)[number];
export const excludeFlag = Flag.choice("exclude", excludedStackServices).pipe(
  Flag.atMost(excludedStackServices.length),
  Flag.withDefault([] as ReadonlyArray<ExcludedStackService>),
);
const modeFlag = Flag.choice("mode", ["native", "docker"] as const).pipe(
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const flags = {
  stack: Flag.string("stack").pipe(Flag.withDefault(DEFAULT_MANAGED_STACK_NAME)),
  mode: modeFlag,
  exclude: excludeFlag,
  detach: Flag.boolean("detach").pipe(Flag.withDefault(false)),
} as const;
export type StartFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const startCommand = Command.make("start", flags).pipe(
  Command.withDescription("Start the local Supabase development stack."),
  Command.withShortDescription("Start local Supabase stack"),
  Command.withHandler((flags) =>
    start(flags).pipe(withCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(provideCliProjectCommandRuntime(Layer.mergeAll(commandRuntimeLayer(["start"])))),
  Command.provide(inkLayer),
);

export { ensureProjectStateIgnored };
