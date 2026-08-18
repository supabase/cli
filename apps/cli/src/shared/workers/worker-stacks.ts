import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRuntime } from "./worker-runtimes.ts";

/**
 * The starter files `supabase workers new` writes, per runtime.
 *
 * The content lives in `./stacks/<runtime>/` as ordinary files, authored in the
 * language they are written in — `index.js` is a `.js` file, `main.py` a `.py`
 * file — rather than as string literals with their newlines and `${}` escaped.
 *
 * A shipped binary has no `stacks/` directory to read, so the content is baked
 * in at build time through the `SUPABASE_WORKER_STACKS` define and the
 * directory is read only when running from source. This is the same
 * embed-with-a-source-fallback shape `shared/functions/serve.ts` uses for its
 * edge-runtime template.
 *
 * Nothing imports the files, which is what keeps them out of the type program:
 * a `deno` starter is not valid under this workspace's Bun types, and
 * `tsconfig.json` excludes the directory. `exclude` is only ineffective when an
 * import forces a file in.
 */
declare const SUPABASE_WORKER_STACKS: string | undefined;

export type WorkerStack = Readonly<Record<string, string>>;

let cachedStacks: Record<WorkerRuntime, WorkerStack> | undefined;

/** Read `./stacks/` off disk — the path taken only when running from source. */
function readStacksFromDisk(): Record<WorkerRuntime, WorkerStack> {
  // `import.meta.url` rather than Bun's `import.meta.dir`: the test runner
  // bundles this module and leaves `dir` undefined.
  const root = fileURLToPath(new URL("stacks", import.meta.url));
  const stacks: Record<string, WorkerStack> = {};
  for (const runtime of readdirSync(root)) {
    const files: Record<string, string> = {};
    for (const name of readdirSync(join(root, runtime))) {
      files[name] = readFileSync(join(root, runtime, name), "utf8");
    }
    stacks[runtime] = files;
  }
  return stacks as Record<WorkerRuntime, WorkerStack>;
}

/**
 * Every runtime's starter files. Resolved once: from the build-time define in a
 * compiled binary, from `./stacks/` when running from source.
 */
export function workerStacks(): Record<WorkerRuntime, WorkerStack> {
  if (cachedStacks !== undefined) {
    return cachedStacks;
  }
  cachedStacks =
    typeof SUPABASE_WORKER_STACKS === "string"
      ? (JSON.parse(SUPABASE_WORKER_STACKS) as Record<WorkerRuntime, WorkerStack>)
      : readStacksFromDisk();
  return cachedStacks;
}
