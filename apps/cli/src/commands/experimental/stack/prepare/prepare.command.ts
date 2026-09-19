import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackPrepare } from "./prepare.handler.ts";
import { STACK_PREPARABLE_CAPABILITIES } from "./prepare.options.ts";

const config = {
  stack: Flag.string("stack").pipe(Flag.withDescription("Name this stack."), Flag.optional),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Open an existing stack by id."),
    Flag.optional,
  ),
  runtime: Flag.choice("runtime", ["auto", "docker", "native"] as const).pipe(
    Flag.withDescription("Runtime to use for a new stack."),
    Flag.withDefault("auto" as const),
  ),
  capability: Flag.atMost(
    Flag.choice("capability", STACK_PREPARABLE_CAPABILITIES),
    STACK_PREPARABLE_CAPABILITIES.length,
  ).pipe(Flag.withDescription("Capability to prepare (repeatable).")),
} as const;

export type StackPrepareFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackPrepareCommand = Command.make("prepare", config).pipe(
  Command.withDescription(
    "Download artifacts for a managed local Supabase stack without starting its services. If the target does not exist, it is created and registered for later listing or destruction.",
  ),
  Command.withShortDescription("Prepare a managed local stack"),
  Command.withExamples([
    { command: "supabase stack prepare", description: "Prepare all enabled stack capabilities" },
    {
      command: "supabase stack prepare --stack feature-a --capability rest",
      description: "Prepare one capability in a named stack",
    },
  ]),
  Command.withHandler((flags) =>
    stackPrepare(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
);
