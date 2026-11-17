import { BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { bucketObjectKey } from "./buckets.upload.ts";

const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));
const posixPath = Effect.runSync(Effect.provide(Path.Path, BunPath.layerPosix));
const win32Path = Effect.runSync(Effect.provide(Path.Path, BunPath.layerWin32));

describe("bucketObjectKey", () => {
  it("maps a single-file objects_path to its basename", () => {
    expect(bucketObjectKey({ path, posixPath }, "assets/file.pdf", "assets/file.pdf")).toBe(
      "file.pdf",
    );
  });

  it("normalises win32 separators in the remote key", () => {
    expect(
      bucketObjectKey({ path: win32Path, posixPath }, "C:\\assets", "C:\\assets\\sub\\b.txt"),
    ).toBe("sub/b.txt");
  });

  it("maps a direct child to its name", () => {
    expect(bucketObjectKey({ path, posixPath }, "assets", "assets/a.txt")).toBe("a.txt");
  });

  it("maps a nested file to its relative posix path", () => {
    expect(bucketObjectKey({ path, posixPath }, "assets", "assets/sub/dir/b.txt")).toBe(
      "sub/dir/b.txt",
    );
  });

  it("normalises a leading ./ in objects_path", () => {
    expect(bucketObjectKey({ path, posixPath }, "./assets", "assets/a.txt")).toBe("a.txt");
  });
});
