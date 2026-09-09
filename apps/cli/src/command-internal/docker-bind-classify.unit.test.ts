import { describe, expect, test } from "vitest";

import { bindMountSpecSource, isBindMountSource } from "./docker-bind-classify.ts";

describe("isBindMountSource", () => {
  test("treats a POSIX absolute path as a bind mount", () => {
    expect(isBindMountSource("/host/functions")).toBe(true);
  });

  test("treats a relative-dot path as a bind mount", () => {
    expect(isBindMountSource("./functions")).toBe(true);
  });

  test("treats a home-relative path as a bind mount", () => {
    expect(isBindMountSource("~/functions")).toBe(true);
  });

  test("treats a Windows drive-letter path as a bind mount", () => {
    expect(isBindMountSource("C:\\repo\\supabase\\functions")).toBe(true);
  });

  test("treats a UNC path as a bind mount", () => {
    expect(isBindMountSource("\\\\server\\share")).toBe(true);
  });

  test("treats a bare name as a named volume, not a bind mount", () => {
    expect(isBindMountSource("supabase_edge_runtime_proj")).toBe(false);
  });
});

describe("bindMountSpecSource", () => {
  test("extracts the source from a POSIX bind spec", () => {
    expect(bindMountSpecSource("/host/functions:/home/deno/functions:ro")).toBe("/host/functions");
  });

  test("extracts the source from a named-volume spec", () => {
    expect(bindMountSpecSource("supabase_edge_runtime_proj:/root/.cache/deno:rw")).toBe(
      "supabase_edge_runtime_proj",
    );
  });

  test("keeps a Windows drive-letter path intact instead of truncating at its internal colon", () => {
    expect(bindMountSpecSource("C:\\repo\\supabase\\functions:/home/deno/functions:ro")).toBe(
      "C:\\repo\\supabase\\functions",
    );
  });

  test("extracts the source from a UNC bind spec", () => {
    expect(bindMountSpecSource("\\\\server\\share:/home/deno/functions:ro")).toBe(
      "\\\\server\\share",
    );
  });

  test("classifies a Windows drive-letter bind spec as a bind mount end-to-end", () => {
    const bind = "C:\\repo\\supabase\\functions:/home/deno/functions:ro";
    expect(isBindMountSource(bindMountSpecSource(bind))).toBe(true);
  });
});
