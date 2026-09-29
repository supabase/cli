import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isResultsCache, readResultEntries, readResultsCaches } from "./vitest-results-cache.ts";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function writeCache(relativeDir: string, cache: unknown): void {
  const cacheDir = join(
    dir ?? (dir = mkdtempSync(join(tmpdir(), "vitest-results-cache-"))),
    relativeDir,
  );
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "results.json"), JSON.stringify(cache));
}

describe("isResultsCache", () => {
  test("accepts a well-formed cache", () => {
    expect(
      isResultsCache({
        version: "5.0.0",
        results: [["unit:src/a.unit.test.ts", { duration: 1, failed: false }]],
      }),
    ).toBe(true);
  });

  test.each([
    [undefined],
    [{}],
    [{ version: "5.0.0" }],
    [{ version: "5.0.0", results: "nope" }],
    [{ version: "5.0.0", results: [["unit:a.ts", { duration: "1", failed: false }]] }],
  ])("rejects %j", (value) => {
    expect(isResultsCache(value)).toBe(false);
  });
});

describe("readResultsCaches", () => {
  test("finds every results.json recursively under a directory", () => {
    writeCache("apps/cli/aaa", {
      version: "5.0.0",
      results: [["unit:src/a.unit.test.ts", { duration: 10, failed: false }]],
    });
    writeCache("packages/api/bbb", {
      version: "5.0.0",
      results: [["unit:src/b.unit.test.ts", { duration: 20, failed: false }]],
    });

    const caches = readResultsCaches(dir!);

    expect(caches).toHaveLength(2);
    expect(caches.flatMap((cache) => cache.results)).toEqual(
      expect.arrayContaining([
        ["unit:src/a.unit.test.ts", { duration: 10, failed: false }],
        ["unit:src/b.unit.test.ts", { duration: 20, failed: false }],
      ]),
    );
  });
});

describe("readResultEntries", () => {
  test("derives the workspace from the staged apps/<name> or packages/<name> path segment and splits the project prefix", () => {
    writeCache("apps/cli/aaa", {
      version: "5.0.0",
      results: [
        ["unit:src/a.unit.test.ts", { duration: 10, failed: false }],
        ["e2e:src/a.e2e.test.ts", { duration: 30, failed: true }],
      ],
    });
    writeCache("packages/api/bbb", {
      version: "5.0.0",
      results: [["integration:src/b.integration.test.ts", { duration: 20, failed: false }]],
    });

    const entries = readResultEntries(dir!);

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          workspace: "apps/cli",
          project: "unit",
          path: "src/a.unit.test.ts",
          duration: 10,
          failed: false,
        },
        {
          workspace: "apps/cli",
          project: "e2e",
          path: "src/a.e2e.test.ts",
          duration: 30,
          failed: true,
        },
        {
          workspace: "packages/api",
          project: "integration",
          path: "src/b.integration.test.ts",
          duration: 20,
          failed: false,
        },
      ]),
    );
  });

  test('falls back to "." for an artifact predating the staging step', () => {
    writeCache("da39a3ee5e6b4b0d3255bfef95601890afd80709", {
      version: "5.0.0",
      results: [["e2e:src/a.e2e.test.ts", { duration: 10, failed: false }]],
    });

    expect(readResultEntries(dir!)).toEqual([
      { workspace: ".", project: "e2e", path: "src/a.e2e.test.ts", duration: 10, failed: false },
    ]);
  });
});
