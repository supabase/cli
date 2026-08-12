import type { Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
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
import { bunSqliteManagedStackRepositoryLayer } from "./managed/sqlite-bun.ts";

export * from "./managed.ts";
export { bunSqliteManagedStackRepositoryLayer };

/** The managed assembly an Effect consumer provides, bound to the Bun runtime. */
export const managedStackLayer = (
  options: CreateManagedStackServiceOptions = {},
): Layer.Layer<ManagedStackRepository | ManagedStackService, ManagedStackLayerFailure> =>
  managedStackLayerWith(BunFileSystem.layer, bunSqliteManagedStackRepositoryLayer, options);

export const createManagedStackService = (
  options: CreateManagedStackServiceOptions = {},
): Promise<ManagedStackServiceHandle> =>
  createManagedStackServiceWith(BunFileSystem.layer, bunSqliteManagedStackRepositoryLayer, options);

export const makeManagedStackService = (
  options: MakeManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => makeManagedStackServiceWith(BunFileSystem.layer, options);
