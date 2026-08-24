import { BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Path } from "effect";

import { buildLegacyPgProveArgs } from "./legacy-test-db.pg-prove-args.ts";

const withPath = <A>(f: (path: Path.Path) => A) =>
  Effect.gen(function* () {
    return f(yield* Path.Path);
  }).pipe(Effect.provide(BunPath.layer));

describe("buildLegacyPgProveArgs", () => {
  it.effect("defaults to <workdir>/supabase/tests when no paths are given", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
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
    }),
  );

  it.effect("resolves relative paths against cwd and mounts them read-only", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
        paths: ["nested"],
        cwd: "/cwd",
        workdir: "/work",
        debug: false,
      });
      expect(result.binds).toEqual(["/cwd/nested:/cwd/nested:ro"]);
      expect(Option.getOrNull(result.workingDir)).toBe("/cwd/nested");
    }),
  );

  it.effect("mounts the containing directory (not the lone file) for a single file path", () =>
    withPath((path) => {
      // CLI-1139: mounting only the file leaves sibling `\ir` includes absent in
      // the container. Mount the parent directory so they resolve; the file path is
      // still what pg_prove runs.
      const result = buildLegacyPgProveArgs({
        path,
        paths: ["/abs/dir/a_test.sql"],
        cwd: "/cwd",
        workdir: "/work",
        debug: false,
      });
      expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
      expect(result.cmd).toContain("/abs/dir/a_test.sql");
      expect(Option.getOrNull(result.workingDir)).toBe("/abs/dir");
    }),
  );

  it.effect("dedupes the bind when multiple files share a directory", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
        paths: ["/abs/dir/a_test.sql", "/abs/dir/b_test.sql"],
        cwd: "/cwd",
        workdir: "/work",
        debug: false,
      });
      // A single bind for the shared directory; both files still run.
      expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
      expect(result.cmd).toContain("/abs/dir/a_test.sql");
      expect(result.cmd).toContain("/abs/dir/b_test.sql");
    }),
  );

  it.effect("dedupes a file's mount against its explicitly-given containing directory", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
        paths: ["/abs/dir", "/abs/dir/a_test.sql"],
        cwd: "/cwd",
        workdir: "/work",
        debug: false,
      });
      expect(result.binds).toEqual(["/abs/dir:/abs/dir:ro"]);
      // workingDir is derived from the first path (a directory → itself).
      expect(Option.getOrNull(result.workingDir)).toBe("/abs/dir");
    }),
  );

  it.effect("keeps the first path's workingDir when multiple paths are given", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
        paths: ["/abs/first_test.sql", "/abs/second/dir"],
        cwd: "/cwd",
        workdir: "/work",
        debug: false,
      });
      expect(result.binds).toEqual([
        // First path is a file → its containing directory is mounted.
        "/abs:/abs:ro",
        // Second path is a directory → mounted as-is.
        "/abs/second/dir:/abs/second/dir:ro",
      ]);
      // workingDir is derived from the first path only (a file → its parent).
      expect(Option.getOrNull(result.workingDir)).toBe("/abs");
      // `hostPaths` reports what pg_prove searches — the files/dirs, not their mounts.
      expect(result.hostPaths).toEqual(["/abs/first_test.sql", "/abs/second/dir"]);
    }),
  );

  it.effect("appends --verbose when debug is enabled", () =>
    withPath((path) => {
      const result = buildLegacyPgProveArgs({
        path,
        paths: [],
        cwd: "/cwd",
        workdir: "/work",
        debug: true,
      });
      expect(result.cmd.at(-1)).toBe("--verbose");
    }),
  );
});
