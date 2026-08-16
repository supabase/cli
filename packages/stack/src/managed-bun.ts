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
import { managedDaemonLayer as managedDaemonLayerForPlatform } from "./managed-daemon.ts";
import { managedDaemonEntryPoint } from "./managed-daemon-bun.ts";

export * from "./managed.ts";
export { bunSqliteManagedStackRepositoryLayer };
export { managedDaemonEntryPoint };
export { ManagedDaemonStartError, type ManagedDaemonStartInput } from "./managed-daemon.ts";

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

export const managedDaemonLayer = (
  input: import("./managed-daemon.ts").ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint);
