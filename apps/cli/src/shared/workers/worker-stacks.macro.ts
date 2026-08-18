import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_RUNTIMES, type WorkerRuntime } from "./worker-runtimes.ts";

/** The files a scaffolded worker is made of, keyed by the name each is written as. */
export type WorkerStack = Readonly<Record<string, string>>;

/**
 * Fails unless every offered runtime has a non-empty stack, and every stack
 * belongs to an offered runtime.
 *
 * The two lists are declared separately — `WORKER_RUNTIMES` drives `--runtime`
 * and the type union, the directory holds the content — so this is what stops
 * them drifting into a runtime users can pick that scaffolds nothing. It runs
 * as the macro is expanded, which is to say at build time.
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
 * Expanded as a Bun macro, so this runs while the importing module is
 * transpiled and its return value is inlined as a literal — a compiled binary
 * carries the content with no `stacks/` directory beside it and no `--define`
 * to forget at a build site. Adding a runtime is adding a directory; nothing
 * here names the files.
 *
 * Bun expands macros in the runtime transpiler too, so running from source
 * behaves the same. Vitest does not implement them, and degrades to calling
 * this as an ordinary function against the source tree — which is why the path
 * comes from `import.meta.url` rather than Bun's `import.meta.dir`, undefined
 * once the test runner has bundled the module.
 *
 * Throwing here fails the build. Bun reports it as a macro that could not be
 * coerced to AST, so the reason is logged first to make the diagnostic legible.
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
