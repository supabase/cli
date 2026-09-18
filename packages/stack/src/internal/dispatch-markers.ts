/** Private argv marker used when a compiled CLI dispatches an embedded Supervisor. */
export const SUPERVISOR_DISPATCH_SENTINEL = "__supabase_stack_supervisor__" as const;

/** Private argv marker used when a compiled CLI dispatches its embedded native launcher. */
export const NATIVE_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_native__" as const;
