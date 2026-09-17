import { BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { bucketObjectKey } from "./buckets.upload.ts";

const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));
const posixPath = Effect.runSync(Effect.provide(Path.Path, BunPath.layerPosix));

describe("bucketObjectKey", () => {
  it("maps a single-file objects_path to <bucket>/<basename>", () => {
    expect(bucketObjectKey(path, posixPath, "docs", "assets/file.pdf", "assets/file.pdf")).toBe(
      "docs/file.pdf",
    );
  });

  it("maps a direct child to <bucket>/<name>", () => {
    expect(bucketObjectKey(path, posixPath, "docs", "assets", "assets/a.txt")).toBe("docs/a.txt");
  });

  it("maps a nested file to <bucket>/<relative-posix-path>", () => {
    expect(bucketObjectKey(path, posixPath, "docs", "assets", "assets/sub/dir/b.txt")).toBe(
      "docs/sub/dir/b.txt",
    );
  });

  it("normalises a leading ./ in objects_path", () => {
    expect(bucketObjectKey(path, posixPath, "docs", "./assets", "assets/a.txt")).toBe("docs/a.txt");
  });
});
