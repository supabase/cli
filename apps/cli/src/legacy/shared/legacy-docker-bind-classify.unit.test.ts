import { describe, expect, test } from "vitest";

import {
  legacyBindMountSpecSource,
  legacyIsBindMountSource,
} from "./legacy-docker-bind-classify.ts";

describe("legacyIsBindMountSource", () => {
  test("treats a POSIX absolute path as a bind mount", () => {
    expect(legacyIsBindMountSource("/host/functions")).toBe(true);
  });

  test("treats a relative-dot path as a bind mount", () => {
    expect(legacyIsBindMountSource("./functions")).toBe(true);
  });

  test("treats a home-relative path as a bind mount", () => {
    expect(legacyIsBindMountSource("~/functions")).toBe(true);
  });

  test("treats a Windows drive-letter path as a bind mount", () => {
    expect(legacyIsBindMountSource("C:\\repo\\supabase\\functions")).toBe(true);
  });

  test("treats a UNC path as a bind mount", () => {
    expect(legacyIsBindMountSource("\\\\server\\share")).toBe(true);
  });

  test("treats a bare name as a named volume, not a bind mount", () => {
    expect(legacyIsBindMountSource("supabase_edge_runtime_proj")).toBe(false);
  });
});

describe("legacyBindMountSpecSource", () => {
  test("extracts the source from a POSIX bind spec", () => {
    expect(legacyBindMountSpecSource("/host/functions:/home/deno/functions:ro")).toBe(
      "/host/functions",
    );
  });

  test("extracts the source from a named-volume spec", () => {
    expect(legacyBindMountSpecSource("supabase_edge_runtime_proj:/root/.cache/deno:rw")).toBe(
      "supabase_edge_runtime_proj",
    );
  });

  test("keeps a Windows drive-letter path intact instead of truncating at its internal colon", () => {
    expect(legacyBindMountSpecSource("C:\\repo\\supabase\\functions:/home/deno/functions:ro")).toBe(
      "C:\\repo\\supabase\\functions",
    );
  });

  test("extracts the source from a UNC bind spec", () => {
    expect(legacyBindMountSpecSource("\\\\server\\share:/home/deno/functions:ro")).toBe(
      "\\\\server\\share",
    );
  });

  test("classifies a Windows drive-letter bind spec as a bind mount end-to-end", () => {
    const bind = "C:\\repo\\supabase\\functions:/home/deno/functions:ro";
    expect(legacyIsBindMountSource(legacyBindMountSpecSource(bind))).toBe(true);
  });
});
