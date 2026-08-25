// @supabase/stack/effect — Node-bound Effect interfaces and consumer layers.

export * from "./effect.ts";

import { Effect, type Layer } from "effect";
import { join } from "node:path";
import type { PortLease } from "./PortAllocator.ts";
import type { Stack } from "./Stack.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import type { ManagedDaemonConfigInput } from "./layers.ts";
import {
  daemonLayer as daemonLayerForPlatform,
  restartManagedStackForUpgrade as restartManagedStackForUpgradeForPlatform,
  foregroundLayer as foregroundLayerForPlatform,
} from "./layers.ts";
import { controlTransportLayer, daemonEntryPoint, platformFactory } from "./platform-node.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import {
  connectManagedLayer,
  deleteManagedStackPersistence as deleteManagedStackPersistenceCore,
  listStacks as listStacksCore,
  resolveManagedStack as resolveManagedStackCore,
  resolveStackSummary as resolveStackSummaryCore,
  stopDaemon as stopDaemonCore,
} from "./discovery.ts";
import {
  resolveManagedDocument as resolveManagedDocumentCore,
  updateManagedLaunch as updateManagedLaunchCore,
} from "./managed/lifecycle.ts";
import { managedStackManagerLayer } from "./managed-node.ts";

export { httpTransportClientLayer };

export const foregroundLayer = (
  config: ResolvedStackConfig,
  portLease: PortLease,
): Layer.Layer<Stack> => foregroundLayerForPlatform(config, platformFactory, portLease);

export const daemonLayer = (input: ManagedDaemonConfigInput) =>
  daemonLayerForPlatform(input, daemonEntryPoint);

export const restartManagedStackForUpgrade = (input: ManagedDaemonConfigInput) =>
  restartManagedStackForUpgradeForPlatform(input, daemonEntryPoint);

const managedLayer = (cacheRoot: string) =>
  managedStackManagerLayer({ stateRoot: join(cacheRoot, "managed") });

export const connectLayer = (opts: Parameters<typeof connectManagedLayer>[0]) =>
  connectManagedLayer(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const resolveManagedStack = (opts: Parameters<typeof resolveManagedStackCore>[0]) =>
  resolveManagedStackCore(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const listStacks = (opts: Parameters<typeof listStacksCore>[0]) =>
  listStacksCore(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const resolveStackSummary = (opts: Parameters<typeof resolveStackSummaryCore>[0]) =>
  resolveStackSummaryCore(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const stopDaemon = (opts: Parameters<typeof stopDaemonCore>[0]) =>
  stopDaemonCore(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const deleteManagedStackPersistence = (
  opts: Parameters<typeof deleteManagedStackPersistenceCore>[0],
) =>
  deleteManagedStackPersistenceCore(opts).pipe(
    Effect.provide(managedLayer(opts.cacheRoot)),
    Effect.provide(controlTransportLayer),
  );

export const resolveManagedDocument = (opts: {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly cwd?: string;
  readonly cacheRoot: string;
}) => resolveManagedDocumentCore(opts).pipe(Effect.provide(managedLayer(opts.cacheRoot)));
export const updateManagedLaunch = (opts: {
  readonly workspacePath: string;
  readonly stackName?: string;
  readonly cwd?: string;
  readonly cacheRoot: string;
  readonly cliVersion: string;
  readonly launch: import("./managed/document.ts").ManagedStackLaunchUpdate;
}) =>
  updateManagedLaunchCore(opts).pipe(
    Effect.provide(managedLayer(opts.cacheRoot)),
    Effect.provide(httpTransportClientLayer),
  );
