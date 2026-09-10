import {
  readComputeStacks,
  type ComputeStack,
} from "./compute-stacks.macro.ts" with { type: "macro" };
import type { ComputeRuntime } from "./compute-runtimes.ts";

/**
 * The starter files `supabase compute new` writes, per runtime — the contents of
 * `./stacks/<runtime>/`, keyed by the name each is scaffolded as. Discovered by reading the
 * directory, as ordinary files rather than string literals, so a new runtime is just a new
 * directory. See `compute-stacks.macro.ts` for how this survives compilation.
 */
export const COMPUTE_STACKS: Record<ComputeRuntime, ComputeStack> = await readComputeStacks();
