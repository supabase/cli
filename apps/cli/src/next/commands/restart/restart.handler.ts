import { loadCliConfig } from "@supabase/config/effect";
import type { CliConfig } from "@supabase/config";
import { Crypto, Effect, FileSystem, Option, Path, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  findStack,
  openStack,
  type EffectStack,
  type FindStackOptions,
} from "@supabase/stack/effect";
import type { StackDescriptor, StackId, StackStatus } from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { StackNotFoundError } from "@supabase/stack/effect";
import { toStartStackConfig } from "../../config/stack-config.ts";
import type { RestartFlags } from "./restart.command.ts";

type RestartRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export type RestartStack = Pick<EffectStack, "restart">;
export interface RestartOperations {
  readonly findStack: (
    options: FindStackOptions,
  ) => Effect.Effect<Option.Option<StackDescriptor>, unknown, RestartRuntime>;
  readonly openStack: (id: StackId) => Effect.Effect<RestartStack, unknown, RestartRuntime>;
  readonly loadConfig: (
    cwd: string,
  ) => Effect.Effect<CliConfig | undefined, unknown, FileSystem.FileSystem | Path.Path>;
}

const defaultOperations: RestartOperations = {
  findStack,
  openStack,
  loadConfig: (cwd) => loadCliConfig(cwd).pipe(Effect.map((loaded) => loaded?.config)),
};

export const restart = Effect.fnUntraced(function* (
  flags: RestartFlags,
  operations: RestartOperations = defaultOperations,
) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  const descriptor = yield* operations.findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptor)) {
    return yield* new StackNotFoundError({ message: "No local Supabase stack was found." });
  }
  const loadedConfig = yield* operations.loadConfig(project.projectRoot);
  const config = toStartStackConfig(loadedConfig, flags.exclude);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* operations.openStack(descriptor.value.id);
      const status: StackStatus = yield* stack.restart({ config });
      yield* output.success(
        status.lifecycle === "running"
          ? "Local Supabase stack restarted."
          : `Local Supabase stack is ${status.lifecycle}.`,
        {
          stack: flags.stack,
          lifecycle: status.lifecycle,
          desired_lifecycle: status.desiredLifecycle,
          runtime: status.runtime,
          endpoints: status.endpoints,
          capabilities: status.capabilities,
        },
      );
    }),
  );
  yield* output.outro(`Local Supabase stack ${flags.stack} restarted.`);
});
