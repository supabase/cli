import { BunFileSystem, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runSupervisor, supervisorTestRuntime } from "./supervisor.ts";
import { managedStackManagerLayer as makeManagerLayer } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer, platformFactory } from "./platform-bun.ts";

const managerLayer = (stateRoot: string) =>
  makeManagerLayer({ stateRoot }).pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, gitConfigStoreLayer, controlTransportLayer)),
  );

/** Thin Bun child entrypoint shared by managed and ordinary detached starts. */
export const runBunDaemon = (): void => {
  void Effect.runPromise(
    runSupervisor({ platformFactory, managerLayer, testRuntime: supervisorTestRuntime }).pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    ),
  );
};

if (import.meta.main) runBunDaemon();
