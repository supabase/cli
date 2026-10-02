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

export const STACK_PREPARABLE_CAPABILITIES = [
  "database",
  ...STACK_START_EXCLUDABLE_CAPABILITIES,
] as const;
