/** Optional capabilities accepted by `stack start --exclude`. */
export const legacyExperimentalStackStartExcludableCapabilities = [
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
