import { Crypto, Effect, FileSystem, Path, Scope } from "effect";
import {
  createStack,
  StackMustBeStoppedError,
  type EffectStack,
  type CreateStackOptions,
} from "@supabase/stack/effect";
import { loadCliConfig } from "@supabase/config/effect";
import type { CliConfig, LoadedCliConfig } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { runtimePreference, toStartStackConfig } from "../../config/stack-config.ts";
import type { StartFlags } from "./start.command.ts";

type StartRuntime =
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export type StartStack = Pick<EffectStack, "start">;
export interface StartOperations {
  readonly createStack: (
    options: CreateStackOptions,
  ) => Effect.Effect<StartStack, unknown, StartRuntime>;
  readonly loadConfig: (
    cwd: string,
  ) => Effect.Effect<
    LoadedCliConfig | CliConfig | undefined,
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
}

const defaultOperations: StartOperations = {
  createStack,
  loadConfig: (cwd) => loadCliConfig(cwd).pipe(Effect.map((loaded) => loaded ?? undefined)),
};

export const start = Effect.fnUntraced(function* (
  flags: StartFlags,
  operations: StartOperations = defaultOperations,
) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  const analytics = yield* Analytics;
  yield* output.intro("Start local Supabase stack");
  yield* ensureProjectStateIgnored(project.projectRoot);
  const loadedConfig = yield* operations.loadConfig(project.projectRoot);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const stack = yield* operations.createStack({
        projectRoot: project.projectRoot,
        name: flags.stack,
        runtime: runtimePreference(flags.mode),
      });
      const config = yield* toStartStackConfig(loadedConfig, flags.exclude);
      const status = yield* stack.start({ config }).pipe(
        Effect.catchIf(
          (error) => error instanceof StackMustBeStoppedError,
          (error) =>
            Effect.fail(
              new StackMustBeStoppedError({
                ...error,
                message: `${error.message}; run supabase restart to apply it`,
                guidance: "Run supabase restart to apply stopped-time changes",
              }),
            ),
        ),
      );
      yield* output.success(
        status.lifecycle === "running"
          ? "Local Supabase stack is running."
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
      yield* analytics.capture("cli_stack_started", {
        mode: flags.mode,
        detach: flags.detach,
        stack: flags.stack,
      });
      if (!flags.detach)
        yield* output.info(`Stack ${flags.stack} remains managed after this command exits.`);
    }),
  );
});
