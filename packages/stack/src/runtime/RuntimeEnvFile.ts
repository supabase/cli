import { Crypto, Effect, FileSystem, Path, PlatformError } from "effect";
import { StackPreparationError } from "../public/Errors.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import type { StackId } from "../public/StackId.ts";

export interface RuntimeEnvFileOwner {
  /** Writes one generation/workload file and returns its exact owned path. */
  readonly write: (input: {
    readonly generation: number;
    readonly workloadId: string;
    readonly values: Readonly<Record<string, string>>;
  }) => Effect.Effect<string, StackPreparationError>;
  /** Removes one exact generation's files; safe when already absent. */
  readonly cleanupGeneration: (generation: number) => Effect.Effect<void, StackPreparationError>;
  /** Removes only this owner's env-file directory; safe when already absent. */
  readonly cleanupAll: Effect.Effect<void, StackPreparationError>;
}

export interface RuntimeEnvFileOwnerOptions {
  readonly stateRoot: string;
  readonly stackId: StackId;
}

const error = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new StackPreparationError({ message, ...fields });

const validGeneration = (generation: number): boolean =>
  Number.isSafeInteger(generation) && generation >= 0;

const validWorkloadId = (workloadId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(workloadId);

const validName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);

const encodeWorkloadId = (workloadId: string): string => encodeURIComponent(workloadId);

const mapFile = <A, R>(
  path: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, StackPreparationError, R> =>
  effect.pipe(
    Effect.mapError(() =>
      error(`Unable to ${operation}`, {
        path,
      }),
    ),
  );

const contentFor = (
  values: Readonly<Record<string, string>>,
): Effect.Effect<string, StackPreparationError> => {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of entries) {
    if (!validName(name) || name.includes("\u0000") || /[\r\n]/u.test(name))
      return Effect.fail(error("Invalid runtime environment variable name"));
    if (value.includes("\u0000") || /[\r\n]/u.test(value))
      return Effect.fail(error("Invalid runtime environment variable value", { name }));
  }
  return Effect.succeed(entries.map(([name, value]) => `${name}=${value}\n`).join(""));
};

/**
 * Owns container env files under `<stack>/runtime/env`. Native workloads use
 * their fd4 environment and never pass through this owner.
 */
export const makeRuntimeEnvFileOwner = (
  options: RuntimeEnvFileOwnerOptions,
): Effect.Effect<
  RuntimeEnvFileOwner,
  StackPreparationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const paths = yield* resolveStackPaths(options).pipe(
      Effect.mapError((cause) => error("Unable to resolve runtime environment path", { cause })),
    );
    const envRoot = path.join(paths.runtime, "env");

    const write = (input: {
      readonly generation: number;
      readonly workloadId: string;
      readonly values: Readonly<Record<string, string>>;
    }): Effect.Effect<string, StackPreparationError> => {
      if (!validGeneration(input.generation))
        return Effect.fail(error("Invalid runtime environment generation"));
      if (!validWorkloadId(input.workloadId))
        return Effect.fail(error("Invalid runtime environment workload identity"));
      return Effect.gen(function* () {
        const text = yield* contentFor(input.values);
        const generationRoot = path.join(envRoot, String(input.generation));
        const target = path.join(generationRoot, `${encodeWorkloadId(input.workloadId)}.env`);
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => error("Unable to allocate runtime environment file name")),
        );
        const temporary = `${target}.${token}.tmp`;
        return yield* Effect.gen(function* () {
          yield* mapFile(
            generationRoot,
            "create runtime environment directory",
            fs.makeDirectory(generationRoot, { recursive: true, mode: 0o700 }),
          );
          yield* mapFile(
            generationRoot,
            "secure runtime environment directory",
            fs.chmod(generationRoot, 0o700),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* mapFile(
                temporary,
                "create runtime environment file",
                fs.open(temporary, { flag: "w", mode: 0o600 }),
              );
              yield* mapFile(
                temporary,
                "write runtime environment file",
                file.writeAll(new TextEncoder().encode(text)),
              );
              yield* mapFile(temporary, "sync runtime environment file", file.sync);
            }),
          );
          yield* mapFile(temporary, "secure runtime environment file", fs.chmod(temporary, 0o600));
          yield* mapFile(target, "publish runtime environment file", fs.rename(temporary, target));
          yield* mapFile(
            target,
            "secure published runtime environment file",
            fs.chmod(target, 0o600),
          );
          return target;
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
      !validGeneration(generation)
        ? Effect.fail(error("Invalid runtime environment generation"))
        : mapFile(
            path.join(envRoot, String(generation)),
            "clean runtime environment generation",
            fs.remove(path.join(envRoot, String(generation)), { recursive: true, force: true }),
          );
    const cleanupAll = mapFile(
      envRoot,
      "clean runtime environment files",
      fs.remove(envRoot, { recursive: true, force: true }),
    );
    return { write, cleanupGeneration, cleanupAll };
  });
