import {
  readComputeStacks,
  type ComputeStack,
} from "./compute-stacks.macro.ts" with { type: "macro" };
import type { ComputeRuntime } from "./compute-runtimes.ts";

/**
 * The starter files `supabase compute new` writes, per runtime — the contents
 * of `./stacks/<runtime>/`, keyed by the name each file is scaffolded as.
 *
 * The content lives there as ordinary files, authored in the language they are
 * written in rather than as string literals, and is discovered by reading the
 * directory: a new runtime is a new directory, with nothing to wire up here.
 * `compute-stacks.macro.ts` explains how that survives compilation.
 */
export const COMPUTE_STACKS: Record<ComputeRuntime, ComputeStack> = readComputeStacks();
