import { Crypto, Data, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
import { contentDigestHex } from "../internal/content-digest.ts";
import { StackIdSchema, type StackId } from "../identity/StackId.ts";

export class FunctionsBootstrapError extends Data.TaggedError("FunctionsBootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly path?: string;
}> {}

export interface FunctionsBootstrapOwner {
  /** The owned directory a caller mounts statically; generations publish underneath it. */
  readonly root: string;
  /** Publishes the stack-owned Edge Runtime main service for the current session. */
  readonly write: (input: {
    readonly content: string;
  }) => Effect.Effect<string, FunctionsBootstrapError>;
  /**
   * Removes every published generation under this owner's root except `keep`. Safe only once a
   * previous generation's container is confirmed stopped, so callers must run this alongside
   * launch preparation rather than during `prepare`, which can run while it is still live.
   */
  readonly pruneOthers: (keep: string) => Effect.Effect<void, FunctionsBootstrapError>;
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

const generationPrefix = "generation-";

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

  // A fresh generation never collides with a path a running container might still reference, so
  // a freshly started container never bind-mounts a path a host's file-sharing cache might still
  // remember as deleted from a previous generation.
  const generationFor = (content: string) =>
    contentDigestHex(crypto, content).pipe(
      Effect.map((hash) => path.join(root, `${generationPrefix}${hash}`)),
    );

  /** A generation is complete only once both its files are published together. */
  const isCompleteGeneration = (generation: string) =>
    fs
      .exists(path.join(generation, "index.ts"))
      .pipe(
        Effect.flatMap((hasTarget) =>
          hasTarget ? fs.exists(path.join(generation, "deno.json")) : Effect.succeed(false),
        ),
      );

  const write = Effect.fn("FunctionsBootstrap.write")(function* (input: {
    readonly content: string;
  }) {
    if (input.content.includes("\u0000"))
      return yield* failure("Functions bootstrap contains an invalid character");
    yield* mapFs(
      root,
      "create functions bootstrap directory",
      fs.makeDirectory(root, { recursive: true, mode: 0o700 }),
    );
    yield* mapFs(root, "secure functions bootstrap directory", fs.chmod(root, 0o700));
    const generation = yield* mapFs(
      root,
      "hash functions bootstrap content",
      generationFor(input.content),
    );
    const target = path.join(generation, "index.ts");
    if (
      yield* mapFs(
        generation,
        "check functions bootstrap generation",
        isCompleteGeneration(generation),
      )
    )
      return yield* mapFs(
        target,
        "resolve published functions bootstrap file",
        fs.realPath(target),
      );
    return yield* Effect.gen(function* () {
      const token = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          failure("Unable to allocate functions bootstrap file", { cause }),
        ),
      );
      const stage = path.join(root, `.${generationPrefix}${token}.tmp`);
      return yield* Effect.gen(function* () {
        yield* mapFs(
          stage,
          "create functions bootstrap stage directory",
          fs.makeDirectory(stage, { recursive: true, mode: 0o700 }),
        );
        const stagedConfig = path.join(stage, "deno.json");
        // An empty workspace root stops Deno config discovery before any ancestor package.json or
        // workspace; a plain `{}` still joins an ancestor Deno workspace and fails membership.
        yield* mapFs(
          stagedConfig,
          "write functions bootstrap config",
          fs.writeFileString(stagedConfig, '{"workspace":[]}\n', { mode: 0o600 }),
        );
        const stagedTarget = path.join(stage, "index.ts");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* mapFs(
              stagedTarget,
              "create functions bootstrap file",
              fs.open(stagedTarget, { flag: "w", mode: 0o600 }),
            );
            yield* mapFs(
              stagedTarget,
              "write functions bootstrap file",
              file.writeAll(new TextEncoder().encode(input.content)),
            );
            yield* mapFs(stagedTarget, "sync functions bootstrap file", file.sync);
          }),
        );
        yield* mapFs(
          stagedTarget,
          "secure functions bootstrap file",
          fs.chmod(stagedTarget, 0o600),
        );
        // One rename publishes both files together, so a container mounting `generation` never
        // observes one without the other. Content is identical for a given name, so a losing
        // overlapping writer's failed rename onto an already-complete generation is a success.
        yield* mapFs(
          generation,
          "publish functions bootstrap generation",
          fs.rename(stage, generation),
        ).pipe(
          Effect.catch((cause) =>
            isCompleteGeneration(generation).pipe(
              Effect.orElseSucceed(() => false),
              Effect.flatMap((complete) => (complete ? Effect.void : Effect.fail(cause))),
            ),
          ),
        );
        return yield* mapFs(
          target,
          "resolve published functions bootstrap file",
          fs.realPath(target),
        );
      }).pipe(
        Effect.ensuring(
          fs
            .remove(stage, { recursive: true, force: true })
            .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
        ),
      );
    });
  });

  const pruneOthers = (keep: string) =>
    mapFs(root, "check functions bootstrap directory", fs.exists(root)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? mapFs(root, "list functions bootstrap generations", fs.readDirectory(root)).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(
                  // Only completed generations are eligible, never a staging entry an in-flight
                  // writer may still own; basenames avoid a false mismatch across symlinks.
                  entries.filter(
                    (entry) => entry.startsWith(generationPrefix) && entry !== path.basename(keep),
                  ),
                  (entry) => {
                    const stale = path.join(root, entry);
                    return mapFs(
                      stale,
                      "remove stale functions bootstrap generation",
                      fs.remove(stale, { recursive: true, force: true }),
                    );
                  },
                  { discard: true },
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.withSpan("FunctionsBootstrap.pruneOthers"),
    );

  const cleanupAll = mapFs(
    root,
    "clean functions bootstrap files",
    fs.remove(root, { recursive: true, force: true }),
  ).pipe(
    Effect.andThen(removeEmptyDirectory(path.dirname(root))),
    Effect.andThen(removeEmptyDirectory(path.dirname(path.dirname(root)))),
    Effect.withSpan("FunctionsBootstrap.cleanupAll"),
  );
  return { root, write, pruneOthers, cleanupAll };
});
