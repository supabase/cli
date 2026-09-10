import {
  readWorkerStacks,
  type WorkerStack,
} from "./worker-stacks.macro.ts" with { type: "macro" };
import type { WorkerRuntime } from "./worker-runtimes.ts";

/**
 * The starter files `supabase experimental workers new` writes, per runtime — the contents of
 * `./stacks/<runtime>/`, keyed by the name each is scaffolded as. Discovered by reading the
 * directory, as ordinary files rather than string literals, so a new runtime is just a new
 * directory. See `worker-stacks.macro.ts` for how this survives compilation.
 */
export const WORKER_STACKS: Record<WorkerRuntime, WorkerStack> = readWorkerStacks();
