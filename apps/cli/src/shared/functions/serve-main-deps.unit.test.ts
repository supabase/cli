import { describe, expect, it } from "vitest";

import { dirname, join, STATUS_CODE, STATUS_TEXT, toFileUrl } from "./serve-main-deps.ts";

describe("posix join", () => {
  it("joins absolute segments with a single separator", () => {
    expect(join("/a/b", "c")).toBe("/a/b/c");
  });

  it("collapses a trailing separator on the base", () => {
    expect(join("/a/b/", "c")).toBe("/a/b/c");
  });

  it("joins a relative base with a file name", () => {
    expect(join("supabase/functions/hello", "package.json")).toBe(
      "supabase/functions/hello/package.json",
    );
  });

  it("resolves parent-directory segments", () => {
    expect(join("/a/b", "../c")).toBe("/a/c");
  });
});

describe("posix dirname", () => {
  it("returns the directory of an absolute file path", () => {
    expect(dirname("/a/b/index.ts")).toBe("/a/b");
  });

  it("returns the directory of a relative file path", () => {
    expect(dirname("supabase/functions/hello/index.ts")).toBe("supabase/functions/hello");
  });

  it("returns the root for a top-level absolute path", () => {
    expect(dirname("/index.ts")).toBe("/");
  });
});

describe("posix toFileUrl", () => {
  it("converts an absolute path to a file URL", () => {
    expect(toFileUrl("/a/b/index.ts").href).toBe("file:///a/b/index.ts");
  });

  it("percent-encodes whitespace in the path", () => {
    expect(toFileUrl("/a b/index.ts").href).toBe("file:///a%20b/index.ts");
  });

  it("rejects a relative path", () => {
    expect(() => toFileUrl("a/b.ts")).toThrow();
  });
});

describe("status constants", () => {
  it("exposes the HTTP status codes used by the runtime template", () => {
    expect(STATUS_CODE.OK).toBe(200);
    expect(STATUS_CODE.Unauthorized).toBe(401);
    expect(STATUS_CODE.NotFound).toBe(404);
    expect(STATUS_CODE.InternalServerError).toBe(500);
    expect(STATUS_CODE.ServiceUnavailable).toBe(503);
  });

  it("maps status codes to their canonical reason phrases", () => {
    expect(STATUS_TEXT[STATUS_CODE.InternalServerError]).toBe("Internal Server Error");
    expect(STATUS_TEXT[STATUS_CODE.OK]).toBe("OK");
  });
});
