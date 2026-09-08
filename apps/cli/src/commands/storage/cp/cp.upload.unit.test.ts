import { describe, expect, it } from "vitest";

import { resolveUploadDstPath } from "./cp.upload.ts";

describe("resolveUploadDstPath", () => {
  describe("single file (relPath === '.')", () => {
    it("appends the file name when the dst prefix is a bucket root", () => {
      // remote "private" → prefix "" is a directory → keep the file name.
      expect(
        resolveUploadDstPath({
          remotePath: "private",
          relPath: ".",
          fileName: "readme.md",
          baseName: "readme.md",
          noSlash: "private",
          dirExists: true,
          fileExists: false,
        }),
      ).toBe("private/readme.md");
    });

    it("keeps the destination key when it targets an existing object", () => {
      // remote "private/file" → prefix "file" is not a dir, and the object exists.
      expect(
        resolveUploadDstPath({
          remotePath: "private/file",
          relPath: ".",
          fileName: "readme.md",
          baseName: "readme.md",
          noSlash: "private/file",
          dirExists: false,
          fileExists: true,
        }),
      ).toBe("private/file");
    });

    it("appends the file name when the dst dir exists and no same-named file does", () => {
      expect(
        resolveUploadDstPath({
          remotePath: "private/docs",
          relPath: ".",
          fileName: "readme.md",
          baseName: "readme.md",
          noSlash: "private/docs",
          dirExists: true,
          fileExists: false,
        }),
      ).toBe("private/docs/readme.md");
    });
  });

  describe("directory walk", () => {
    it("nests under baseName for a new bucket (noSlash empty)", () => {
      expect(
        resolveUploadDstPath({
          remotePath: "",
          relPath: "readme.md",
          fileName: "readme.md",
          baseName: "tmp",
          noSlash: "",
          dirExists: false,
          fileExists: false,
        }),
      ).toBe("tmp/readme.md");
    });

    it("nests under baseName when the destination dir exists", () => {
      expect(
        resolveUploadDstPath({
          remotePath: "/private/dir/",
          relPath: "readme.md",
          fileName: "readme.md",
          baseName: "tmp",
          noSlash: "/private/dir",
          dirExists: true,
          fileExists: false,
        }),
      ).toBe("/private/dir/tmp/readme.md");
    });

    it("preserves a nested relative path under baseName", () => {
      expect(
        resolveUploadDstPath({
          remotePath: "/private/dir/",
          relPath: "docs/api.md",
          fileName: "api.md",
          baseName: "tmp",
          noSlash: "/private/dir",
          dirExists: true,
          fileExists: false,
        }),
      ).toBe("/private/dir/tmp/docs/api.md");
    });

    it("does not nest under baseName when it is '.' (cwd source)", () => {
      expect(
        resolveUploadDstPath({
          remotePath: "/private",
          relPath: "readme.md",
          fileName: "readme.md",
          baseName: ".",
          noSlash: "/private",
          dirExists: true,
          fileExists: false,
        }),
      ).toBe("/private/readme.md");
    });
  });
});
