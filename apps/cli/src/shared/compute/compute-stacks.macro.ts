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
 * Fails unless every offered runtime has a non-empty stack, and every stack
 * belongs to an offered runtime.
 *
 * The two lists are declared separately — `COMPUTE_RUNTIMES` drives `--runtime`
 * and the type union, the directory holds the content — so this is what stops
 * them drifting into a runtime users can pick that scaffolds nothing. It runs
 * as the macro is expanded, which is to say at build time.
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
 * Failure here fails the build. Bun reports it as a macro that could not be
 * coerced to AST, so the reason is logged first to make the diagnostic legible.
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
