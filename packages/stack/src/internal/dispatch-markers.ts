/** Private argv marker used when a compiled CLI dispatches its embedded native launcher. */
export const NATIVE_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_native__" as const;

/** Private argv marker used when a compiled CLI dispatches its embedded stack owner. */
export const HOST_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_host__" as const;

/** Identifies Bun's virtual module roots in source and standalone builds. */
export const isBunVirtualPath = (value: string): boolean =>
  /(?:^|[\\/])(?:\$bunfs|~BUN)(?:[\\/]|$)/.test(value);
