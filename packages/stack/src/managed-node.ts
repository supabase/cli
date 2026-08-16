import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Layer } from "effect";
import {
  managedDaemonLayer as managedDaemonLayerForPlatform,
  type ManagedDaemonStartInput,
} from "./supervisor.ts";
import { daemonEntryPoint as managedDaemonEntryPoint } from "./platform-node.ts";
import {
  createManagedStackManager as createManagedStackManagerCore,
  managedStackManagerLayer as managedStackManagerLayerCore,
  type ManagedStackManagerHandle,
} from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-node.ts";

export * from "./managed.ts";
export { managedDaemonEntryPoint };
export { ManagedDaemonStartError, type ManagedDaemonStartInput } from "./supervisor.ts";

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

export const createManagedStackManager = (options: {
  readonly stateRoot: string;
}): Promise<ManagedStackManagerHandle> =>
  createManagedStackManagerCore(managedStackManagerLayer(options));

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint);
