import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, Exit, FileSystem, Layer, Path, Ref, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import {
  ContainerError,
  ContainerLaunchError,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";
import { makeService } from "../Service.ts";
import {
  makeProcessRecipe,
  type ProcessDependencies,
  type ProcessRecipeSpec,
} from "./ProcessRecipe.ts";
import type { CatalogOptions, RecipeCreation } from "./Recipe.ts";

type TestCreation = RecipeCreation<"rest", Record<string, never>> & {
  readonly service: "rest";
  readonly version: "v16.2";
};

const creation: TestCreation = {
  service: "rest",
  version: "v16.2",
  config: {},
};

const options: CatalogOptions = {
  stackId: "process-recipe-test",
  instanceId: "rest",
  root: "/tmp/process-recipe-test",
  cacheRoot: "/tmp/process-recipe-test-cache",
  runtime: "docker",
};

const spec: ProcessRecipeSpec<TestCreation> = {
  service: "rest",
  executable: "postgrest",
  ports: { http: 8080 },
  healthPath: "/",
  args: () => Effect.succeed([]),
  env: () => Effect.succeed({}),
  mounts: () => Effect.succeed([]),
  startup: [{ args: [] }],
};

describe("ProcessRecipe launch cleanup", () => {
  for (const scenario of [
    "partial launch",
    "startup wait failure",
    "startup remove failure",
  ] as const) {
    it.effect(`retains a ${scenario} container for retry`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const startupLaunches = yield* Ref.make(0);
          const serviceLaunches = yield* Ref.make(0);
          const active = yield* Ref.make(0);
          const cleanupFailure = yield* Ref.make<"stop" | undefined>("stop");
          const startupRemoveFailed = yield* Ref.make(scenario === "startup remove failure");
          const makeProcess = (
            id: string,
            exitCode: Effect.Effect<number, ContainerError>,
          ): ContainerProcess => ({
            id,
            ports: { 8080: 18080 },
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode,
            stdin: Sink.drain,
            stop: Effect.gen(function* () {
              if ((yield* Ref.get(cleanupFailure)) === "stop")
                return yield* new ContainerError({
                  operation: "stop",
                  message: "temporary stop failure",
                });
              yield* Ref.set(active, 0);
            }),
            remove: Effect.gen(function* () {
              if (yield* Ref.getAndSet(startupRemoveFailed, false))
                return yield* new ContainerError({
                  operation: "remove",
                  message: "temporary startup remove failure",
                });
              yield* Ref.set(active, 0);
            }),
          });
          const container: ContainerRuntime = {
            prepare: () => Effect.void,
            launchTool: () =>
              Effect.gen(function* () {
                const launch = yield* Ref.updateAndGet(startupLaunches, (value) => value + 1);
                if (launch === 1) {
                  yield* Ref.set(active, 1);
                  if (scenario === "partial launch")
                    return yield* new ContainerLaunchError({
                      failure: new ContainerError({
                        operation: "start",
                        message: "container did not start",
                      }),
                      process: makeProcess("partial-startup", Effect.never),
                    });
                  if (scenario === "startup wait failure")
                    return makeProcess(
                      "failed-startup",
                      Effect.fail(
                        new ContainerError({
                          operation: "exit",
                          message: "startup process failed",
                        }),
                      ),
                    );
                  return makeProcess("remove-failure-startup", Effect.succeed(0));
                }
                expect(yield* Ref.get(active)).toBe(0);
                yield* Ref.set(active, 1);
                return makeProcess("startup", Effect.succeed(0));
              }),
            launch: () =>
              Effect.gen(function* () {
                expect(yield* Ref.get(active)).toBe(0);
                yield* Ref.updateAndGet(serviceLaunches, (value) => value + 1);
                yield* Ref.set(active, 1);
                return makeProcess("service", Effect.never);
              }),
          };
          const dependencies = {
            fs: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            client: yield* HttpClient.HttpClient,
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            container,
          } satisfies ProcessDependencies;
          const recipe = yield* makeProcessRecipe(creation, options, dependencies, spec);
          const service = yield* makeService(recipe.definition, {
            id: `rest-process-recipe-${scenario}`,
            config: creation,
          });

          expect(Exit.isFailure(yield* service.start.pipe(Effect.exit))).toBe(true);
          expect((yield* service.get).lifecycle).toBe("stopping");
          expect((yield* service.get).cleanupError?.operation).toBe("stop");
          expect(yield* Ref.get(startupLaunches)).toBe(1);
          expect(yield* Ref.get(serviceLaunches)).toBe(0);
          expect(yield* Ref.get(active)).toBe(1);

          yield* Ref.set(cleanupFailure, undefined);
          yield* service.start;
          expect((yield* service.get).lifecycle).toBe("running");
          expect(yield* Ref.get(startupLaunches)).toBe(2);
          expect(yield* Ref.get(serviceLaunches)).toBe(1);
          expect(yield* Ref.get(active)).toBe(1);
          yield* service.stop;
        }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      ),
    );
  }
});
