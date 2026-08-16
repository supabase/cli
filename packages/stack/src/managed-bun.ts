import type { Layer } from "effect";
import { Layer as EffectLayer } from "effect";
import { BunServices } from "@effect/platform-bun";
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
import {
  managedDaemonLayer as managedDaemonLayerForPlatform,
  type ManagedDaemonStartInput,
} from "./supervisor.ts";
import { daemonEntryPoint as managedDaemonEntryPoint } from "./platform-bun.ts";
import {
  createManagedStackManager as createManagedStackManagerCore,
  managedStackManagerLayer as managedStackManagerLayerCore,
  type ManagedStackManagerHandle,
} from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-bun.ts";

export * from "./managed.ts";
export { bunSqliteManagedStackRepositoryLayer };
export { managedDaemonEntryPoint };
export { ManagedDaemonStartError, type ManagedDaemonStartInput } from "./supervisor.ts";

export const managedStackManagerLayer = (options: { readonly stateRoot: string }) =>
  managedStackManagerLayerCore(options).pipe(
    EffectLayer.provide(
      EffectLayer.mergeAll(BunServices.layer, gitConfigStoreLayer, controlTransportLayer),
    ),
  );

export const createManagedStackManager = (options: {
  readonly stateRoot: string;
}): Promise<ManagedStackManagerHandle> =>
  createManagedStackManagerCore(managedStackManagerLayer(options));

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
  input: ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint);
