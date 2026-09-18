import { Crypto, Data, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
import { StackIdSchema, type StackId } from "../identity/StackId.ts";

export class FunctionsBootstrapError extends Data.TaggedError("FunctionsBootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly path?: string;
}> {}

export interface FunctionsBootstrapOwner {
  /** Publishes the stack-owned Edge Runtime main service for the current session. */
  readonly write: (input: {
    readonly content: string;
  }) => Effect.Effect<string, FunctionsBootstrapError>;
  /** Removes only this stack's functions bootstrap root. */
  readonly cleanupAll: Effect.Effect<void, FunctionsBootstrapError>;
}

export interface FunctionsBootstrapOwnerOptions {
  readonly root: string;
  readonly stackId: StackId;
  readonly instanceId: string;
}

const failure = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new FunctionsBootstrapError({ message, ...fields });

const mapFs = <A, R = never>(
  path: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, FunctionsBootstrapError, R> =>
  effect.pipe(Effect.mapError((cause) => failure(`Unable to ${operation}`, { path, cause })));

export const makeFunctionsBootstrapOwner = Effect.fn("FunctionsBootstrap.makeOwner")(function* (
  options: FunctionsBootstrapOwnerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  yield* Schema.decodeEffect(StackIdSchema)(options.stackId).pipe(
    Effect.mapError((cause) => failure("Invalid stack identity", { cause })),
  );
  if (!/^[a-zA-Z0-9_-]+$/u.test(options.instanceId))
    return yield* failure("Invalid Functions instance identity");
  const root = path.join(options.root, options.instanceId, "runtime", "functions");
  const removeEmptyDirectory = (directory: string) =>
    Effect.tryPromise({
      try: () => rmdir(directory),
      catch: (cause) =>
        failure("Unable to clean Functions parent directory", { path: directory, cause }),
    }).pipe(
      Effect.catch((cause) => {
        const code =
          typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
            ? cause.cause.code
            : undefined;
        return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST"
          ? Effect.void
          : Effect.fail(cause);
      }),
    );

  const write = Effect.fn("FunctionsBootstrap.write")(function* (input: {
    readonly content: string;
  }) {
    if (input.content.includes("\u0000"))
      return yield* failure("Functions bootstrap contains an invalid character");
    const target = path.join(root, "index.ts");
    return yield* Effect.gen(function* () {
      const token = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          failure("Unable to allocate functions bootstrap file", { cause }),
        ),
      );
      const temporary = path.join(root, `.index.ts.${token}.tmp`);
      return yield* Effect.gen(function* () {
        yield* mapFs(
          root,
          "create functions bootstrap directory",
          fs.makeDirectory(root, { recursive: true, mode: 0o700 }),
        );
        yield* mapFs(root, "secure functions bootstrap directory", fs.chmod(root, 0o700));
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
        yield* mapFs(target, "secure published functions bootstrap file", fs.chmod(target, 0o600));
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
  });

  const cleanupAll = mapFs(
    root,
    "clean functions bootstrap files",
    fs.remove(root, { recursive: true, force: true }),
  ).pipe(
    Effect.andThen(removeEmptyDirectory(path.dirname(root))),
    Effect.andThen(removeEmptyDirectory(path.dirname(path.dirname(root)))),
    Effect.withSpan("FunctionsBootstrap.cleanupAll"),
  );
  return { write, cleanupAll };
});
