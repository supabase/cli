import type { BreakingChange } from "./define.ts";
import { targetFlagsDefault } from "./target-flags-default.ts";

/** Every breaking change the docs generator reports, in migration guide order within a theme. */
export const BREAKING_CHANGES: ReadonlyArray<BreakingChange> = [targetFlagsDefault];
