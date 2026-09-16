import { describe, expect, test } from "vitest";
import { Option } from "effect";

import { buildPgProveArgs } from "./test-db.pg-prove-args.ts";

describe("buildPgProveArgs", () => {
  test("defaults to <workdir>/supabase/tests when no paths are given", () => {
    const result = buildPgProveArgs({
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
    const result = buildPgProveArgs({
      paths: ["nested"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/cwd/nested:/cwd/nested:ro"]);
    expect(Option.getOrNull(result.workingDir)).toBe("/cwd/nested");
  });

  test("mounts the containing directory (not the lone file) for a single file path", () => {
    const result = buildPgProveArgs({
      paths: ["/abs/dir/a_test.sql"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
    expect(result.cmd).toContain("/abs/dir/a_test.sql");
    expect(Option.getOrNull(result.workingDir)).toBe("/abs/dir");
  });

  test("dedupes the bind when multiple files share a directory", () => {
    const result = buildPgProveArgs({
      paths: ["/abs/dir/a_test.sql", "/abs/dir/b_test.sql"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
    expect(result.cmd).toContain("/abs/dir/a_test.sql");
    expect(result.cmd).toContain("/abs/dir/b_test.sql");
  });

  test("dedupes a file's mount against its explicitly-given containing directory", () => {
    const result = buildPgProveArgs({
      paths: ["/abs/dir", "/abs/dir/a_test.sql"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
    expect(Option.getOrNull(result.workingDir)).toBe("/abs/dir");
  });

  test("keeps the first path's workingDir when multiple paths are given", () => {
    const result = buildPgProveArgs({
      paths: ["/abs/first_test.sql", "/abs/second/dir"],
      cwd: "/cwd",
      workdir: "/work",
      debug: false,
    });
    expect(result.binds).toEqual(["/abs:/abs:ro", "/abs/second/dir:/abs/second/dir:ro"]);
    expect(Option.getOrNull(result.workingDir)).toBe("/abs");
    expect(result.hostPaths).toEqual(["/abs/first_test.sql", "/abs/second/dir"]);
  });

  test("appends --verbose when debug is enabled", () => {
    const result = buildPgProveArgs({
      paths: [],
      cwd: "/cwd",
      workdir: "/work",
      debug: true,
    });
    expect(result.cmd.at(-1)).toBe("--verbose");
  });
});
