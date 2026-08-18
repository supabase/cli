import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { DEFAULT_WORKER_RUNTIME, type WorkerRuntime } from "./worker-runtimes.ts";

/**
 * Best-effort classification of a worker directory into a {@link WorkerRuntime}
 * from common marker files, so `supabase workers push` can deploy a directory
 * that has no `[workers.<name>] runtime` at all. The guess is always reported,
 * with a nudge to pin it down, rather than applied silently.
 */

interface WorkerClassification {
  readonly runtime: WorkerRuntime;
  /** Human-readable reason, for the line `push` logs about the guess. */
  readonly reason: string;
}

const MARKERS: ReadonlyArray<{
  readonly runtime: WorkerRuntime;
  readonly files: ReadonlyArray<string>;
}> = [
  // An explicit Dockerfile always wins: it is a deliberate signal, not an
  // inference.
  { runtime: "dockerfile", files: ["Dockerfile"] },
  // Deno and Bun are checked before plain `package.json` because either can
  // still have one (editor tooling, a stray dependency) while a plain Node
  // project has no `deno.json`/`bun.lock`.
  { runtime: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"] },
  { runtime: "bun", files: ["bun.lockb", "bun.lock"] },
  { runtime: "node", files: ["package.json"] },
  { runtime: "python", files: ["requirements.txt", "pyproject.toml", "Pipfile"] },
];

export const classifyWorkerDir = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;

  for (const marker of MARKERS) {
    for (const file of marker.files) {
      const found = yield* fs.exists(join(dir, file)).pipe(Effect.orElseSucceed(() => false));
      if (found) {
        return { runtime: marker.runtime, reason: `found ${file}` } satisfies WorkerClassification;
      }
    }
  }

  return {
    runtime: DEFAULT_WORKER_RUNTIME,
    reason: `no recognized marker files, defaulting to ${DEFAULT_WORKER_RUNTIME}`,
  } satisfies WorkerClassification;
});
