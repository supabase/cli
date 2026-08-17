import { BunServices } from "@effect/platform-bun";
import { Layer as EffectLayer } from "effect";
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
export { managedDaemonEntryPoint };
export type { ManagedDaemonStartInput } from "./supervisor.ts";

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

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint);
