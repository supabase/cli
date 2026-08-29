import { Effect, FileSystem, Option, Path, Stream } from "effect";
import { loadCliConfig } from "@supabase/config/effect";
import type { CliConfig } from "@supabase/config";
import { createStack, findStack, openStack } from "@supabase/stack/effect";
import { join } from "node:path";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { toStartStackConfig } from "../../../config/stack-config.ts";
import type { FunctionsDevFlags } from "./dev.command.ts";

export interface ServeManagedFunctionsOperations {
  readonly findStack: typeof findStack;
  readonly createStack: typeof createStack;
  readonly openStack: typeof openStack;
  readonly loadConfig: (
    cwd: string,
  ) => Effect.Effect<CliConfig | undefined, unknown, FileSystem.FileSystem | Path.Path>;
}

export const runFunctionsDevRuntime = Effect.fnUntraced(function* (flags: FunctionsDevFlags) {
  return yield* serveManagedFunctions({
    projectRoot: (yield* CliProjectHome).projectRoot,
    stackName: flags.stack,
  });
});

/** Serves every local Function through the stack-owned Edge Runtime. */
export const serveManagedFunctions = Effect.fnUntraced(function* (
  options: {
    readonly projectRoot: string;
    readonly stackName: string;
  },
  operations: ServeManagedFunctionsOperations = {
    findStack,
    createStack,
    openStack,
    loadConfig: (cwd) => loadCliConfig(cwd).pipe(Effect.map((loaded) => loaded?.config)),
  },
) {
  const output = yield* Output;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const descriptor = yield* operations.findStack({
        projectRoot: options.projectRoot,
        name: options.stackName,
      });
      const stack = Option.isNone(descriptor)
        ? yield* operations.createStack({
            projectRoot: options.projectRoot,
            name: options.stackName,
            runtime: { kind: "container" },
          })
        : yield* operations.openStack(descriptor.value.id);
      const functionsRoot = join(options.projectRoot, "supabase", "functions");
      const loadedConfig = yield* operations.loadConfig(options.projectRoot);
      const translated = toStartStackConfig(loadedConfig, [], "docker", options.projectRoot);
      const functionsCapability = translated.capabilities?.functions;
      const functionsConfig =
        functionsCapability !== undefined &&
        "enabled" in functionsCapability &&
        functionsCapability.enabled === false
          ? { settings: { functions_root: functionsRoot } }
          : {
              ...functionsCapability,
              settings: {
                ...(functionsCapability !== undefined && "settings" in functionsCapability
                  ? functionsCapability.settings
                  : {}),
                functions_root: functionsRoot,
              },
            };
      const status = yield* stack.start({
        config: {
          ...translated,
          capabilities: {
            ...translated.capabilities,
            functions: functionsConfig,
          },
        },
      });
      yield* output.success(`Functions stack is ${status.lifecycle}.`, {
        stack: options.stackName,
        functions_root: functionsRoot,
        lifecycle: status.lifecycle,
      });
      yield* stack
        .logs({ capabilities: ["functions"], follow: true })
        .pipe(Stream.runForEach((entry) => output.info(`[${entry.source}] ${entry.message}`)));
    }),
  );
});
