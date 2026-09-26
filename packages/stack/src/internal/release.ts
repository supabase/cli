import { Crypto, Effect, FileSystem, Path } from "effect";
import effectPackage from "effect/package.json" with { type: "json" };
import { fileURLToPath } from "node:url";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Digests the regular `.ts` modules under `sourceRoot`, skipping symlinks and other entries. */
export const sourceDigest = Effect.fn("Release.sourceDigest")(function* (sourceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const regularFile = (file: string) =>
    fs.readLink(path.join(sourceRoot, file)).pipe(
      Effect.as(false),
      Effect.catch(() =>
        fs.stat(path.join(sourceRoot, file)).pipe(Effect.map((info) => info.type === "File")),
      ),
    );
  const modules = yield* Effect.filter(
    (yield* fs.readDirectory(sourceRoot, { recursive: true }))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .toSorted(),
    regularFile,
  );
  const encoder = new TextEncoder();
  const parts: Array<Uint8Array> = [encoder.encode(`effect@${effectPackage.version}\0`)];
  for (const file of modules)
    parts.push(
      encoder.encode(`${file}\0`),
      yield* fs.readFile(path.join(sourceRoot, file)),
      encoder.encode("\0"),
    );
  const content = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    content.set(part, offset);
    offset += part.length;
  }
  return hex(yield* crypto.digest("SHA-256", content)).slice(0, 16);
});

/**
 * Digests this package's module sources and its Effect version, which together determine the
 * owner's behavior and wire protocol. Source runs and CLI builds of the same sources agree on it.
 */
export const stackSourceDigest = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* sourceDigest(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
});
