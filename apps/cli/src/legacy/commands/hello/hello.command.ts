import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";

const helloLegacy = Effect.gen(function* () {
  const output = yield* Output;
  yield* output.success("hello legacy");
});

export const helloLegacyCommand = Command.make("hello").pipe(
  Command.withDescription("Print a minimal legacy shell confirmation."),
  Command.withShortDescription("Print hello legacy"),
  Command.withHandler(() =>
    helloLegacy.pipe(withCommandInstrumentation({ analytics: false }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["hello"])),
);
