import type { Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
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

export * from "./managed.ts";
export { nodeSqliteManagedStackRepositoryLayer };

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
