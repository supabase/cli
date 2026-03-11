// @supabase/stack/effect — Effect API for CLI and advanced consumers.
// Platform-agnostic: pass platformFactory/daemonEntryPoint from @supabase/stack/bun or /node.

// Stack service
export type { StackInfo } from "./Stack.ts";
export { Stack } from "./Stack.ts";

// Layer factories
export type { DaemonConfig } from "./layers.ts";
export { connectLayer, DaemonStartError, daemonLayer, foregroundLayer } from "./layers.ts";

// Discovery
export type { StackSummary } from "./discovery.ts";
export { listStacks, stopDaemon } from "./discovery.ts";

// Config resolution
export { resolveConfig, resolveDaemonConfig } from "./createStack.ts";

// Platform types (needed to pass to layer factories)
export type { PlatformFactory, PlatformLayer } from "./createStack.ts";

// State types
export type { StackState } from "./StateManager.ts";
export { NoRunningStackError, StackAlreadyRunningError } from "./StateManager.ts";
