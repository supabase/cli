import { assertCompleteWorkerStacks, workerStacks } from "../src/shared/workers/worker-stacks.ts";

/**
 * The `--define` that bakes the worker starter files into a compiled binary.
 *
 * Built here rather than inline in each build script so there is one definition
 * to pass at every `bun build` site, and so the completeness check runs before
 * any target is compiled: a stack directory that is empty, missing, or not
 * matched by `WORKER_RUNTIMES` fails the build instead of producing a binary
 * whose `workers new` scaffolds nothing.
 */
export function workerStacksDefine(): string {
  const stacks = workerStacks();
  assertCompleteWorkerStacks(stacks);
  return `--define=SUPABASE_WORKER_STACKS=${JSON.stringify(JSON.stringify(stacks))}`;
}
