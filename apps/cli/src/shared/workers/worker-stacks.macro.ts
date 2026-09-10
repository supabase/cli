import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_RUNTIMES, type WorkerRuntime } from "./worker-runtimes.ts";

/** The files a scaffolded worker is made of, keyed by the name each is written as. */
export type WorkerStack = Readonly<Record<string, string>>;

/**
 * Fails unless every offered runtime has a non-empty stack and every stack matches an offered
 * runtime — the two lists (`WORKER_RUNTIMES` and this directory) are declared separately, so this
 * is what stops them drifting apart. Runs at build time, as the macro is expanded.
 */
function assertCompleteWorkerStacks(
  stacks: Record<string, WorkerStack>,
): asserts stacks is Record<WorkerRuntime, WorkerStack> {
  const offered = new Set<string>(WORKER_RUNTIMES);
  const present = new Set(Object.keys(stacks));

  const missing = [...offered].filter((runtime) => !present.has(runtime));
  if (missing.length > 0) {
    throw new Error(`no starter files for ${missing.join(", ")}`);
  }
  const unexpected = [...present].filter((runtime) => !offered.has(runtime));
  if (unexpected.length > 0) {
    throw new Error(
      `stacks/${unexpected.join(", stacks/")} has no matching entry in WORKER_RUNTIMES`,
    );
  }
  for (const [runtime, files] of Object.entries(stacks)) {
    if (Object.keys(files).length === 0) {
      throw new Error(`stacks/${runtime} is empty`);
    }
  }
}

/**
 * Every runtime's starter files, discovered by reading `./stacks/`.
 *
 * Expanded as a Bun macro so the content is inlined into the transpiled output — a compiled
 * binary needs no `stacks/` directory beside it. Bun expands macros in the source-tree transpiler
 * too, but Vitest doesn't, so it calls this as an ordinary function against the source tree —
 * hence `import.meta.url` rather than `import.meta.dir`, which is undefined once bundled.
 * Throwing here fails the build; Bun reports only that the macro couldn't be coerced to AST, so
 * the reason is logged first to keep the diagnostic legible.
 */
export function readWorkerStacks(): Record<WorkerRuntime, WorkerStack> {
  const root = fileURLToPath(new URL("stacks", import.meta.url));
  const stacks: Record<string, WorkerStack> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // `README.md` sits beside the runtime directories and documents them.
    if (!entry.isDirectory()) {
      continue;
    }
    const files: Record<string, string> = {};
    for (const name of readdirSync(join(root, entry.name))) {
      files[name] = readFileSync(join(root, entry.name, name), "utf8");
    }
    stacks[entry.name] = files;
  }

  try {
    assertCompleteWorkerStacks(stacks);
  } catch (cause) {
    console.error(`[worker-stacks] ${String(cause)}`);
    throw cause;
  }
  return stacks;
}
