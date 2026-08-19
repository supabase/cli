import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBaselineCacheKey, digestArtifactTree } from "./native-isolated-shadow-key.ts";

describe("computeBaselineCacheKey", () => {
  it("changes when the postgres version or expose flag changes", () => {
    const base = {
      postgresVersion: "17.6.1.158",
      autoExposeNewTables: false,
      artifactDigest: "abc",
      initScriptDigest: "init-a",
    };
    const key = computeBaselineCacheKey(base);
    expect(key).toHaveLength(16);
    expect(computeBaselineCacheKey({ ...base, postgresVersion: "17.6.1.200" })).not.toBe(key);
    expect(computeBaselineCacheKey({ ...base, autoExposeNewTables: true })).not.toBe(key);
    expect(computeBaselineCacheKey({ ...base, artifactDigest: "def" })).not.toBe(key);
    expect(computeBaselineCacheKey({ ...base, initScriptDigest: "init-b" })).not.toBe(key);
  });
});

describe("digestArtifactTree", () => {
  it("is stable for the same files and changes when contents change", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-digest-"));
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "migrations", "01.sql"), "select 1;\n");
    const first = digestArtifactTree(root);
    expect(digestArtifactTree(root)).toBe(first);
    writeFileSync(join(root, "migrations", "01.sql"), "select 2;\n");
    expect(digestArtifactTree(root)).not.toBe(first);
  });
});
