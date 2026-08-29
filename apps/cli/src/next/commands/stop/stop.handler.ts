import { Effect, Option } from "effect";
import { findStack, openStack, StackNotFoundError } from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { StopFlags } from "./stop.command.ts";

export const stop = Effect.fnUntraced(function* (flags: StopFlags) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Stop local Supabase stack");
  const descriptorOption = yield* findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption)) {
    return yield* new StackNotFoundError({ message: "No local Supabase stack was found." });
  }
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* openStack(descriptorOption.value.id);
      yield* stack.stop();
      if (flags.noBackup) yield* stack.destroy();
    }),
  );
  if (flags.noBackup) {
    yield* output.success("Local Supabase stopped and persisted data deleted");
    yield* output.outro("Local Supabase stack stopped and local data deleted.");
  } else {
    yield* output.success("Local Supabase stopped");
    yield* output.outro("Local Supabase stack stopped.");
  }
});
