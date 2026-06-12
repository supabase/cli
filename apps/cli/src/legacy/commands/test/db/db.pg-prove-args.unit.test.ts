import { describe, expect, test } from "vitest";
import { Option } from "effect";

import { buildLegacyPgProveArgs, legacyToDockerPath } from "./db.pg-prove-args.ts";

describe("legacyToDockerPath", () => {
  test("leaves a posix path unchanged", () => {
    expect(legacyToDockerPath("/work/project/supabase/tests")).toBe("/work/project/supabase/tests");
  });

  test("strips a Windows volume and converts backslashes", () => {
    expect(legacyToDockerPath("C:\\Users\\me\\tests\\a_test.sql")).toBe(
      "/Users/me/tests/a_test.sql",
    );
  });
});

describe("buildLegacyPgProveArgs", () => {
  test("defaults to <workdir>/supabase/tests when no paths are given", () => {
    const result = buildLegacyPgProveArgs({
      paths: [],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.cmd).toEqual([
      "pg_prove",
      "--ext",
      ".pg",
      "--ext",
      ".sql",
      "-r",
      "/work/supabase/tests",
    ]);
    expect(result.binds).toEqual(["/work/supabase/tests:/work/supabase/tests:ro"]);
    expect(Option.getOrNull(result.workingDir)).toBe("/work/supabase/tests");
  });

  test("resolves relative paths against cwd and mounts them read-only", () => {
    const result = buildLegacyPgProveArgs({
      paths: ["nested"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/cwd/nested:/cwd/nested:ro"]);
    expect(Option.getOrNull(result.workingDir)).toBe("/cwd/nested");
  });

  test("uses the parent directory as workingDir when the first path is a file", () => {
    const result = buildLegacyPgProveArgs({
      paths: ["/abs/dir/a_test.sql"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(Option.getOrNull(result.workingDir)).toBe("/abs/dir");
  });

  test("keeps the first path's workingDir when multiple paths are given", () => {
    const result = buildLegacyPgProveArgs({
      paths: ["/abs/first_test.sql", "/abs/second/dir"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual([
      "/abs/first_test.sql:/abs/first_test.sql:ro",
      "/abs/second/dir:/abs/second/dir:ro",
    ]);
    // workingDir is derived from the first path only (a file → its parent).
    expect(Option.getOrNull(result.workingDir)).toBe("/abs");
  });

  test("appends --verbose when debug is enabled", () => {
    const result = buildLegacyPgProveArgs({
      paths: [],
      cwd: "/cwd",
      workdir: "/work",
      debug: true,
    });
    expect(result.cmd.at(-1)).toBe("--verbose");
  });
});
