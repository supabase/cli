import { describe, expect, it } from "@effect/vitest";

import { bucketObjectKey } from "./buckets.upload.ts";

describe("bucketObjectKey", () => {
  it("maps a single-file objects_path to <bucket>/<basename>", () => {
    expect(bucketObjectKey("docs", "assets/file.pdf", "assets/file.pdf")).toBe("docs/file.pdf");
  });

  it("maps a direct child to <bucket>/<name>", () => {
    expect(bucketObjectKey("docs", "assets", "assets/a.txt")).toBe("docs/a.txt");
  });

  it("maps a nested file to <bucket>/<relative-posix-path>", () => {
    expect(bucketObjectKey("docs", "assets", "assets/sub/dir/b.txt")).toBe("docs/sub/dir/b.txt");
  });

  it("normalises a leading ./ in objects_path", () => {
    expect(bucketObjectKey("docs", "./assets", "assets/a.txt")).toBe("docs/a.txt");
  });
});
