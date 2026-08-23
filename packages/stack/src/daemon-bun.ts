// oxlint-disable effecttsgo/any-unknown-in-error-context -- The detached Bun entrypoint forwards the supervisor's process-boundary Cause.
import { BunFileSystem, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runSupervisor } from "./supervisor.ts";
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
    runSupervisor({ platformFactory, managerLayer }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          BunFileSystem.layer,
          gitConfigStoreLayer,
          controlTransportLayer,
        ),
      ),
    ),
  );
};

if (import.meta.main) runBunDaemon();
