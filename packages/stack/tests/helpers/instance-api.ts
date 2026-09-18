import { NodeServices } from "@effect/platform-node";
import { Effect, Path } from "effect";
import { makePromiseApi } from "../../src/public/PromiseStack.ts";
import { defaultRuntimeEnvironment } from "../../src/supervisor/Launcher.ts";

export const isolatedInstanceApi = (projectRoot: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = yield* defaultRuntimeEnvironment;
    const api = makePromiseApi(NodeServices.layer, {
      ...environment,
      stateRoot: path.join(projectRoot, ".stack-state"),
      artifactCacheRoot:
        environment.artifactCacheRoot ?? path.join(environment.stateRoot, "artifacts"),
    });
    return {
      ...api,
      createStack: (options: Parameters<typeof api.createStack>[0]) =>
        api.createStack({
          ...options,
          name: `${options.name ?? "test"}-${path.basename(projectRoot)}`,
        }),
    };
  });
