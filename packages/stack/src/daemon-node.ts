// oxlint-disable effecttsgo/any-unknown-in-error-context -- The detached Node entrypoint forwards the supervisor's process-boundary Cause.
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { runSupervisor } from "./supervisor.ts";
import { managedStackManagerLayer as makeManagerLayer } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer, platformFactory } from "./platform-node.ts";

const managerLayer = (stateRoot: string) =>
  makeManagerLayer({ stateRoot }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        gitConfigStoreLayer,
        controlTransportLayer,
      ),
    ),
  );

/** Thin Node child entrypoint shared by managed and ordinary detached starts. */
export const runNodeSupervisor = (): void => {
  void Effect.runPromise(
    runSupervisor({ platformFactory, managerLayer }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeFileSystem.layer,
          NodePath.layer,
          gitConfigStoreLayer,
          controlTransportLayer,
        ),
      ),
    ),
  );
};

if (import.meta.main) runNodeSupervisor();
