import { Crypto, Data, Effect, FileSystem, Path, type PlatformError, Schema } from "effect";
import { contentDigestHex } from "../internal/content-digest.ts";
import { publishGeneration } from "../internal/generation-publish.ts";
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

  const write = Effect.fn("FunctionsBootstrap.write")(function* (input: {
    readonly content: string;
  }) {
    if (input.content.includes("\u0000"))
      return yield* failure("Functions bootstrap contains an invalid character");
    const hash = yield* mapFs(
      root,
      "hash functions bootstrap content",
      contentDigestHex(crypto, input.content),
    );
    const generation = yield* mapFs(
      root,
      "publish functions bootstrap generation",
      // An empty workspace root stops Deno config discovery before any ancestor package.json or
      // workspace; a plain `{}` still joins an ancestor Deno workspace and fails membership.
      publishGeneration(fs, path, root, `${generationPrefix}${hash}`, [
        { name: "deno.json", content: '{"workspace":[]}\n', mode: 0o600 },
        { name: "index.ts", content: input.content, mode: 0o600 },
      ]),
    );
    const target = path.join(generation, "index.ts");
    return yield* mapFs(target, "resolve published functions bootstrap file", fs.realPath(target));
  });

  return { root, write };
});
