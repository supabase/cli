import { Crypto, Effect, FileSystem, Option, Path, Scope } from "effect";
import {
  findStack,
  openStack,
  StackNotFoundError,
  type EffectStack,
  type FindStackOptions,
  type StackDescriptor,
  type StackId,
} from "@supabase/stack/effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { StopFlags } from "./stop.command.ts";

type StopRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;
type StopStack = Pick<EffectStack, "stop" | "destroy">;
export interface StopOperations {
  readonly findStack: (
    options: FindStackOptions,
  ) => Effect.Effect<Option.Option<StackDescriptor>, unknown, StopRuntime>;
  readonly openStack: (id: StackId) => Effect.Effect<StopStack, unknown, StopRuntime>;
}

const defaultOperations: StopOperations = { findStack, openStack };

export const stop = Effect.fnUntraced(function* (
  flags: StopFlags,
  operations: StopOperations = defaultOperations,
) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Stop local Supabase stack");
  const descriptorOption = yield* operations.findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption)) {
    return yield* new StackNotFoundError({ message: "No local Supabase stack was found." });
  }
  const descriptor = descriptorOption.value;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* operations.openStack(descriptor.id);
      // Stable stop is what makes destroy possible when an older owner speaks a different RPC release.
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
