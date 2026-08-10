// @supabase/stack/effect — Bun-bound Effect interfaces and consumer layers.

export * from "./effect.ts";

import type { Layer } from "effect";
import type { PortLease } from "./PortAllocator.ts";
import type { Stack } from "./Stack.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import type { DaemonConfigInput } from "./StackConfigResolver.ts";
import {
  daemonLayer as daemonLayerForPlatform,
  foregroundLayer as foregroundLayerForPlatform,
} from "./layers.ts";
import { daemonEntryPoint, platformFactory, unixHttpClientLayer } from "./platform-bun.ts";

export { unixHttpClientLayer };

export const foregroundLayer = (
  config: ResolvedStackConfig,
  portLease: PortLease,
): Layer.Layer<Stack> => foregroundLayerForPlatform(config, platformFactory, portLease);

export const daemonLayer = (input: DaemonConfigInput) =>
  daemonLayerForPlatform(input, daemonEntryPoint);
