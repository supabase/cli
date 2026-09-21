import { STACK_START_EXCLUDABLE_CAPABILITIES } from "../start/start.options.ts";

export const STACK_PREPARABLE_CAPABILITIES = [
  "database",
  ...STACK_START_EXCLUDABLE_CAPABILITIES,
] as const;
