import { Crypto, Effect, FileSystem, Path, PlatformError } from "effect";
import { StackPreparationError } from "../public/Errors.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import type { StackId } from "../public/StackId.ts";

export interface FunctionsBootstrapOwner {
  /** Publishes the stack-owned Edge Runtime main service for one generation. */
  readonly write: (input: {
    readonly generation: number;
    readonly content: string;
  }) => Effect.Effect<string, StackPreparationError>;
  readonly cleanupGeneration: (generation: number) => Effect.Effect<void, StackPreparationError>;
  /** Removes only this stack's functions bootstrap root. */
  readonly cleanupAll: Effect.Effect<void, StackPreparationError>;
}

export interface FunctionsBootstrapOwnerOptions {
  readonly stateRoot: string;
  readonly stackId: StackId;
}

const failure = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new StackPreparationError({ message, ...fields });

const mapFs = <A, R = never>(
  path: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, StackPreparationError, R> =>
  effect.pipe(Effect.mapError((cause) => failure(`Unable to ${operation}`, { path, cause })));

export const makeFunctionsBootstrapOwner = (
  options: FunctionsBootstrapOwnerOptions,
): Effect.Effect<
  FunctionsBootstrapOwner,
  StackPreparationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const stackPaths = yield* resolveStackPaths(options).pipe(
      Effect.mapError((cause) => failure("Unable to resolve functions bootstrap path", { cause })),
    );
    const root = path.join(stackPaths.runtime, "functions");

    const write = (input: {
      readonly generation: number;
      readonly content: string;
    }): Effect.Effect<string, StackPreparationError> => {
      if (!Number.isSafeInteger(input.generation) || input.generation < 0)
        return Effect.fail(failure("Invalid functions bootstrap generation"));
      if (input.content.includes("\u0000"))
        return Effect.fail(failure("Functions bootstrap contains an invalid character"));
      const generationRoot = path.join(root, String(input.generation));
      const target = path.join(generationRoot, "index.ts");
      return Effect.gen(function* () {
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            failure("Unable to allocate functions bootstrap file", { cause }),
          ),
        );
        const temporary = path.join(generationRoot, `.index.ts.${token}.tmp`);
        return yield* Effect.gen(function* () {
          yield* mapFs(
            generationRoot,
            "create functions bootstrap directory",
            fs.makeDirectory(generationRoot, { recursive: true, mode: 0o700 }),
          );
          yield* mapFs(
            generationRoot,
            "secure functions bootstrap directory",
            fs.chmod(generationRoot, 0o700),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* mapFs(
                temporary,
                "create functions bootstrap file",
                fs.open(temporary, { flag: "w", mode: 0o600 }),
              );
              yield* mapFs(
                temporary,
                "write functions bootstrap file",
                file.writeAll(new TextEncoder().encode(input.content)),
              );
              yield* mapFs(temporary, "sync functions bootstrap file", file.sync);
            }),
          );
          yield* mapFs(temporary, "secure functions bootstrap file", fs.chmod(temporary, 0o600));
          yield* mapFs(target, "publish functions bootstrap file", fs.rename(temporary, target));
          yield* mapFs(
            target,
            "secure published functions bootstrap file",
            fs.chmod(target, 0o600),
          );
          return yield* mapFs(
            target,
            "resolve published functions bootstrap file",
            fs.realPath(target),
          );
        }).pipe(
          Effect.ensuring(
            fs
              .remove(temporary, { force: true })
              .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
          ),
        );
      });
    };

    const cleanupGeneration = (generation: number): Effect.Effect<void, StackPreparationError> =>
      !Number.isSafeInteger(generation) || generation < 0
        ? Effect.fail(failure("Invalid functions bootstrap generation"))
        : mapFs(
            path.join(root, String(generation)),
            "clean functions bootstrap generation",
            fs.remove(path.join(root, String(generation)), { recursive: true, force: true }),
          );
    const cleanupAll = mapFs(
      root,
      "clean functions bootstrap files",
      fs.remove(root, { recursive: true, force: true }),
    );
    return { write, cleanupGeneration, cleanupAll };
  });
