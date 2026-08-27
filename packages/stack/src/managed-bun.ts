import { BunServices } from "@effect/platform-bun";
import { Effect, Layer as EffectLayer } from "effect";
import {
  managedDaemonLayer as managedDaemonLayerForPlatform,
  type ManagedDaemonStartInput,
} from "./supervisor.ts";
import { daemonEntryPoint as managedDaemonEntryPoint } from "./platform-bun.ts";
import { managedStackManagerLayer as managedStackManagerLayerCore } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { controlTransportLayer } from "./platform-bun.ts";

export * from "./managed.ts";
export { controlTransportLayer };
export { managedDaemonEntryPoint };
export type { ManagedDaemonStartInput } from "./supervisor.ts";

export const managedStackManagerLayer = (options: { readonly stateRoot: string }) =>
  managedStackManagerLayerCore(options).pipe(
    EffectLayer.provide(
      EffectLayer.mergeAll(BunServices.layer, gitConfigStoreLayer, controlTransportLayer),
    ),
  );

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
): ReturnType<typeof managedDaemonLayerForPlatform> =>
  managedDaemonLayerForPlatform(input, managedDaemonEntryPoint).pipe(
    Effect.provide(BunServices.layer),
  );
