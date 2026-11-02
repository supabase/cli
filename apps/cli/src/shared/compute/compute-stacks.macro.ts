import { BunServices } from "@effect/platform-bun";
import { Console, Data, Effect, FileSystem, Path } from "effect";

import { COMPUTE_RUNTIMES, type ComputeRuntime } from "./compute-runtimes.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/** The files a scaffolded compute is made of, keyed by the name each is written as. */
export type ComputeStack = Readonly<Record<string, string>>;

/**
 * Fails unless every offered runtime has a non-empty stack and every stack matches an offered
 * runtime — the two lists (`COMPUTE_RUNTIMES` and this directory) are declared separately, so this
 * is what stops them drifting apart. Runs at build time, as the macro is expanded.
 */
export class ComputeStacksValidationError extends Data.TaggedError("ComputeStacksValidationError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.impossibleState;
  }
}

function validateComputeStacks(
  stacks: Record<string, ComputeStack>,
): Effect.Effect<Record<ComputeRuntime, ComputeStack>, ComputeStacksValidationError> {
  return Effect.gen(function* () {
    const offered = new Set<string>(COMPUTE_RUNTIMES);
    const present = new Set(Object.keys(stacks));

    const missing = [...offered].filter((runtime) => !present.has(runtime));
    if (missing.length > 0) {
      return yield* new ComputeStacksValidationError({
        message: `no starter files for ${missing.join(", ")}`,
      });
    }
    const unexpected = [...present].filter((runtime) => !offered.has(runtime));
    if (unexpected.length > 0) {
      return yield* new ComputeStacksValidationError({
        message: `stacks/${unexpected.join(", stacks/")} has no matching entry in COMPUTE_RUNTIMES`,
      });
    }
    for (const [runtime, files] of Object.entries(stacks)) {
      if (Object.keys(files).length === 0) {
        return yield* new ComputeStacksValidationError({
          message: `stacks/${runtime} is empty`,
        });
      }
    }
    return stacks;
  });
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
export const loadComputeStacks = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stacks: Record<string, ComputeStack> = {};

    for (const entry of yield* fs.readDirectory(root)) {
      const entryPath = path.join(root, entry);
      const entryInfo = yield* fs.stat(entryPath);
      // `README.md` sits beside the runtime directories and documents them.
      if (entryInfo.type !== "Directory") {
        continue;
      }

      const files: Record<string, string> = {};
      for (const name of yield* fs.readDirectory(entryPath)) {
        const filePath = path.join(entryPath, name);
        files[name] = yield* fs.readFileString(filePath);
      }
      stacks[entry] = files;
    }

    return yield* validateComputeStacks(stacks);
  }).pipe(Effect.tapError((error) => Console.error(`[compute-stacks] ${error.message}`)));

const readComputeStacksEffect = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("stacks", import.meta.url));
  return yield* loadComputeStacks(root);
});

export function readComputeStacks(): Promise<Record<ComputeRuntime, ComputeStack>> {
  return Effect.runPromise(readComputeStacksEffect.pipe(Effect.provide(BunServices.layer)));
}
