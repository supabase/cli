import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Layer } from "effect";
import {
  createManagedStackServiceWith,
  makeManagedStackServiceWith,
  managedStackLayerWith,
  type CreateManagedStackServiceOptions,
  type MakeManagedStackServiceOptions,
  type ManagedStackLayerFailure,
  type ManagedStackServiceHandle,
} from "./managed/create-service.ts";
import type { ManagedStackRepository } from "./managed/repository.ts";
import type { ManagedStackService } from "./managed/service.ts";
import { nodeSqliteManagedStackRepositoryLayer } from "./managed/sqlite-node.ts";
import { managedDaemonLayer as managedDaemonLayerForPlatform } from "./managed-daemon.ts";
import { managedDaemonEntryPoint } from "./managed-daemon-node.ts";
import {
  createManagedStackManager as createManagedStackManagerCore,
  managedStackManagerLayer as managedStackManagerLayerCore,
  type ManagedStackManagerHandle,
} from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-node.ts";

export * from "./managed.ts";
export { nodeSqliteManagedStackRepositoryLayer };
export { managedDaemonEntryPoint };
export { ManagedDaemonStartError, type ManagedDaemonStartInput } from "./managed-daemon.ts";

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

/** The managed assembly an Effect consumer provides, bound to the Node runtime. */
export const managedStackLayer = (
  options: CreateManagedStackServiceOptions = {},
): Layer.Layer<ManagedStackRepository | ManagedStackService, ManagedStackLayerFailure> =>
  managedStackLayerWith(NodeFileSystem.layer, nodeSqliteManagedStackRepositoryLayer, options);

export const createManagedStackService = (
  options: CreateManagedStackServiceOptions = {},
): Promise<ManagedStackServiceHandle> =>
  createManagedStackServiceWith(
    NodeFileSystem.layer,
    nodeSqliteManagedStackRepositoryLayer,
    options,
  );

export const makeManagedStackService = (
  options: MakeManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => makeManagedStackServiceWith(NodeFileSystem.layer, options);

export const managedDaemonLayer = (
  input: import("./managed-daemon.ts").ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint);
