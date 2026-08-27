import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  managedDaemonLayer as managedDaemonLayerForPlatform,
  type ManagedDaemonStartInput,
} from "./supervisor.ts";
import { daemonEntryPoint as managedDaemonEntryPoint } from "./platform-node.ts";
import { managedStackManagerLayer as managedStackManagerLayerCore } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-node.ts";

export * from "./managed.ts";
export { controlTransportLayer };
export { managedDaemonEntryPoint };
export type { ManagedDaemonStartInput } from "./supervisor.ts";

export const managedStackManagerLayer = (options: { readonly stateRoot: string }) =>
  managedStackManagerLayerCore(options).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        gitConfigStoreLayer,
        controlTransportLayer,
      ),
    ),
  );

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodePath.layer),
  );
