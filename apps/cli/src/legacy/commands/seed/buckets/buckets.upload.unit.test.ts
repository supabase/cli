import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { legacyBucketObjectKey } from "./buckets.upload.ts";

describe("legacyBucketObjectKey", () => {
  it.effect("maps a single-file objects_path to <bucket>/<basename>", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Path.Path.pipe(Effect.provide(Path.layer));
      expect(
        legacyBucketObjectKey(path, posixPath, "docs", "assets/file.pdf", "assets/file.pdf"),
      ).toBe("docs/file.pdf");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("maps a direct child to <bucket>/<name>", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Path.Path.pipe(Effect.provide(Path.layer));
      expect(legacyBucketObjectKey(path, posixPath, "docs", "assets", "assets/a.txt")).toBe(
        "docs/a.txt",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("maps a nested file to <bucket>/<relative-posix-path>", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Path.Path.pipe(Effect.provide(Path.layer));
      expect(legacyBucketObjectKey(path, posixPath, "docs", "assets", "assets/sub/dir/b.txt")).toBe(
        "docs/sub/dir/b.txt",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("normalises a leading ./ in objects_path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Path.Path.pipe(Effect.provide(Path.layer));
      expect(legacyBucketObjectKey(path, posixPath, "docs", "./assets", "assets/a.txt")).toBe(
        "docs/a.txt",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
