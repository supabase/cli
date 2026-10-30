import { fileURLToPath } from "node:url";

declare const SUPABASE_STACK_BUILD_ID: string | undefined;
/** Defined by builds that compile the CLI to a standalone executable outside Bun. */
declare const SUPABASE_STACK_STANDALONE: boolean | undefined;

/** Private argv marker used when a compiled CLI dispatches its embedded native launcher. */
export const NATIVE_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_native__" as const;

/** Private argv marker used when a compiled CLI dispatches its embedded stack owner. */
export const HOST_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_host__" as const;

/** Identifies Bun's virtual module roots in source and standalone builds. */
export const isBunVirtualPath = (value: string): boolean =>
  /(?:^|[\\/])(?:\$bunfs|~BUN)(?:[\\/]|$)/.test(value);

/** Argv prefix that re-runs the current program as a dispatch target: sentinel in standalone binaries, bundle plus sentinel in built bundles, the source module otherwise. */
export const dispatchArgvFor = (
  moduleUrl: string,
  sourceRelativePath: string,
  sentinel: string,
): ReadonlyArray<string> => {
  if (typeof SUPABASE_STACK_STANDALONE === "boolean" || isBunVirtualPath(moduleUrl))
    return [sentinel];
  const sourceEntrypoint = fileURLToPath(new URL(sourceRelativePath, moduleUrl));
  if (isBunVirtualPath(sourceEntrypoint)) return [sentinel];
  return typeof SUPABASE_STACK_BUILD_ID === "string"
    ? [fileURLToPath(moduleUrl), sentinel]
    : [sourceEntrypoint];
};
