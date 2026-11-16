import { describe, expect, it } from "@effect/vitest";
import { containedIn, windowsFinalPath } from "./FileSystem.ts";

describe("template containment", () => {
  it("holds a resolved path at or below the root, never a sibling sharing its prefix", () => {
    for (const path of ["/project", "/project/invite.html", "/project/a/b.html"])
      expect(containedIn("/project", path, false), path).toBe(true);
    for (const path of ["/projects/invite.html", "/project-other/x", "/", "/etc/passwd"])
      expect(containedIn("/project", path, false), path).toBe(false);
    expect(containedIn("/", "/etc/passwd", false)).toBe(true);
  });

  it("compares Windows paths case-insensitively with backslash separators", () => {
    expect(containedIn("C:\\Project", "c:\\project\\invite.html", true)).toBe(true);
    expect(containedIn("C:\\Project", "C:\\Projects\\invite.html", true)).toBe(false);
    expect(containedIn("\\\\server\\share", "\\\\server\\share\\a.html", true)).toBe(true);
  });
});

describe("Windows final handle path", () => {
  it("drops the long-path prefix so it reads like realpath", () => {
    expect(windowsFinalPath("\\\\?\\C:\\Project\\invite.html")).toBe("C:\\Project\\invite.html");
    expect(windowsFinalPath("\\\\?\\UNC\\server\\share\\a.html")).toBe("\\\\server\\share\\a.html");
    expect(windowsFinalPath("C:\\Project\\invite.html")).toBe("C:\\Project\\invite.html");
  });
});
