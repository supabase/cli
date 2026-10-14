import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../../../shared/output/machine-error-context.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackDestroy } from "./destroy.handler.ts";

const config = {
  stack: Flag.String("stack").pipe(
    Flag.withDescription(
      "Destroy the stack with this name (defaults to the current project stack).",
    ),
    Flag.optional,
  ),
  stackId: Flag.String("stack-id").pipe(
    Flag.withDescription(
      "Destroy an existing stack by id or unique id prefix; repeat to select several. A full id, such as a container's `com.supabase.stack` label, also selects the containers a deleted stack left behind.",
    ),
    Flag.atLeast(0),
  ),
} as const;

export type StackDestroyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackDestroyCommand = Command.make("destroy", config).pipe(
  Command.withDescription(
    "Permanently destroy a managed local stack and its owned data, preserving Storage uploads.",
  ),
  Command.withShortDescription("Destroy a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack destroy --stack feature-a --yes",
      description: "Permanently destroy the feature-a stack",
    },
    {
      command: "supabase stack destroy --stack-id 019532ab --stack-id 019532cd --yes",
      description: "Permanently destroy multiple stacks by id or unique id prefix",
    },
  ]),
  Command.withHandler((flags) =>
    stackDestroy(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  // `stdinLayer` satisfies `promptYesNo`'s `Stdin` requirement. destroy either rejects a
  // non-TTY run up front or short-circuits the prompt via `--yes`, so the layer is here for
  // the effect's type requirements only. `machineErrorContextLayer` lists the stacks a
  // partly failed batch did destroy on the JSON/stream-json error envelope.
  Command.provide(Layer.mergeAll(stdinLayer, machineErrorContextLayer)),
);
