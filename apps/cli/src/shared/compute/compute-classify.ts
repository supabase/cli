import { Effect, FileSystem, Path } from "effect";
import { DEFAULT_COMPUTE_RUNTIME, type ComputeRuntime } from "./compute-runtimes.ts";

/**
 * Best-effort classification of a compute directory into a {@link ComputeRuntime}
 * from common marker files, so `supabase compute push` can deploy a directory
 * that has no `[compute.<name>] runtime` at all. The guess is always reported,
 * with a nudge to pin it down, rather than applied silently.
 */

interface ComputeClassification {
  readonly runtime: ComputeRuntime;
  /** Human-readable reason, for the line `push` logs about the guess. */
  readonly reason: string;
}

const MARKERS: ReadonlyArray<{
  readonly runtime: ComputeRuntime;
  readonly files: ReadonlyArray<string>;
}> = [
  // An explicit Dockerfile always wins: it is a deliberate signal, not an
  // inference.
  { runtime: "dockerfile", files: ["Dockerfile"] },
  // Deno is checked before plain `package.json` because a Deno project can
  // still have one (editor tooling, a stray dependency) while a Node project
  // has no `deno.json`.
  { runtime: "deno", files: ["deno.json", "deno.jsonc", "deno.lock"] },
  { runtime: "node", files: ["package.json"] },
];

export const classifyComputeDir = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const marker of MARKERS) {
    for (const file of marker.files) {
      const found = yield* fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false));
      if (found) {
        return { runtime: marker.runtime, reason: `found ${file}` } satisfies ComputeClassification;
      }
    }
  }

  return {
    runtime: DEFAULT_COMPUTE_RUNTIME,
    reason: `no recognized marker files, defaulting to ${DEFAULT_COMPUTE_RUNTIME}`,
  } satisfies ComputeClassification;
});
