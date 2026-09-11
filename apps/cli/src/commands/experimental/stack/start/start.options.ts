/** Optional capabilities accepted by `stack start --exclude`. */
export const STACK_START_EXCLUDABLE_CAPABILITIES = [
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
] as const;
