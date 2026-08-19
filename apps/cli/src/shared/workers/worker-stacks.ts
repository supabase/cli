import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
import { WORKER_RUNTIMES, type WorkerRuntime } from "./worker-runtimes.ts";

/**
 * The starter files `supabase workers new` writes, per runtime.
 *
 * The content lives in `./stacks/<runtime>/` as ordinary files, authored in the
 * language they are written in, rather than as string literals with their
 * newlines and `${}` escaped. `./stacks/README.md` documents them and is not
 * part of any stack — only directories are read.
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

/**
 * Raised when the starter files are neither baked in nor on disk.
 *
 * This is the failure a missed `--define` produces, and it is worth a loud
 * error rather than a silent one: without it `workers new` would report success
 * having scaffolded an empty directory, and only in a released binary — dev
 * runs and CI read the directory and stay green.
 */
export class WorkerStacksUnavailableError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "WorkerStacksUnavailableError";

  constructor(detail: string) {
    super(
      `worker starter files are unavailable (${detail}). A compiled binary embeds them through ` +
        "the SUPABASE_WORKER_STACKS define; check that every `bun build` invocation in " +
        "apps/cli/scripts/build.ts and build-binary.ts passes `workerStacksDefine`.",
    );
    this.name = "WorkerStacksUnavailableError";
  }

  // A binary that cannot find its own starter files is a packaging fault, not
  // anything the user did.
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

/** Read `./stacks/` off disk — the path taken only when running from source. */
function readStacksFromDisk(): Record<string, WorkerStack> {
  // `import.meta.url` rather than Bun's `import.meta.dir`: the test runner
  // bundles this module and leaves `dir` undefined.
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
  return stacks;
}

/**
 * Fails unless every offered runtime has a non-empty stack, and every stack
 * belongs to an offered runtime.
 *
 * The two lists are declared separately — `WORKER_RUNTIMES` drives `--runtime`
 * and the type union, the directory holds the content — so this is what stops
 * them drifting into a runtime users can pick that scaffolds nothing.
 */
export function assertCompleteWorkerStacks(
  stacks: Record<string, WorkerStack>,
): asserts stacks is Record<WorkerRuntime, WorkerStack> {
  const offered = new Set<string>(WORKER_RUNTIMES);
  const present = new Set(Object.keys(stacks));

  const missing = [...offered].filter((runtime) => !present.has(runtime));
  if (missing.length > 0) {
    throw new WorkerStacksUnavailableError(`no starter files for ${missing.join(", ")}`);
  }
  const unexpected = [...present].filter((runtime) => !offered.has(runtime));
  if (unexpected.length > 0) {
    throw new WorkerStacksUnavailableError(
      `stacks/${unexpected.join(", stacks/")} has no matching entry in WORKER_RUNTIMES`,
    );
  }
  for (const [runtime, files] of Object.entries(stacks)) {
    if (Object.keys(files).length === 0) {
      throw new WorkerStacksUnavailableError(`stacks/${runtime} is empty`);
    }
  }
}

let cachedStacks: Record<WorkerRuntime, WorkerStack> | undefined;

/**
 * Every runtime's starter files. Resolved once: from the build-time define in a
 * compiled binary, from `./stacks/` when running from source.
 */
export function workerStacks(): Record<WorkerRuntime, WorkerStack> {
  if (cachedStacks !== undefined) {
    return cachedStacks;
  }

  let stacks: Record<string, WorkerStack>;
  if (typeof SUPABASE_WORKER_STACKS === "string") {
    stacks = JSON.parse(SUPABASE_WORKER_STACKS) as Record<string, WorkerStack>;
  } else {
    try {
      stacks = readStacksFromDisk();
    } catch (cause) {
      throw new WorkerStacksUnavailableError(
        `the build define is unset and ./stacks/ could not be read: ${String(cause)}`,
      );
    }
  }

  assertCompleteWorkerStacks(stacks);
  cachedStacks = stacks;
  return cachedStacks;
}
