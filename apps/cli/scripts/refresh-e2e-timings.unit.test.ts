import { describe, expect, test } from "vitest";
import { mergeTimings, type VitestResultsCache } from "./refresh-e2e-timings.ts";

const vitestVersion = "5.0.0";

function cache(...results: VitestResultsCache["results"]): VitestResultsCache {
  return { version: vitestVersion, results };
}

describe("mergeTimings", () => {
  test("keeps only e2e project entries and strips the project prefix", () => {
    const timings = mergeTimings(
      [
        cache(
          ["e2e:src/start.e2e.test.ts", { duration: 1200, failed: false }],
          ["unit:src/start.unit.test.ts", { duration: 5, failed: false }],
          [":src/start.integration.test.ts", { duration: 40, failed: false }],
        ),
      ],
      { vitestVersion },
    );

    expect(timings).toEqual({ "src/start.e2e.test.ts": 1200 });
  });

  test("skips failed entries and reports each one", () => {
    const warnings: string[] = [];

    const timings = mergeTimings(
      [
        cache(
          ["e2e:src/ok.e2e.test.ts", { duration: 100, failed: false }],
          ["e2e:src/broken.e2e.test.ts", { duration: 5, failed: true }],
        ),
      ],
      { vitestVersion, warn: (message) => warnings.push(message) },
    );

    expect(timings).toEqual({ "src/ok.e2e.test.ts": 100 });
    expect(warnings).toEqual(["skipping failed src/broken.e2e.test.ts"]);
  });

  test("takes the longest duration when a file appears in several caches", () => {
    const timings = mergeTimings(
      [
        cache(["e2e:src/shared.e2e.test.ts", { duration: 300, failed: false }]),
        cache(["e2e:src/shared.e2e.test.ts", { duration: 450, failed: false }]),
        cache(["e2e:src/shared.e2e.test.ts", { duration: 120, failed: false }]),
      ],
      { vitestVersion },
    );

    expect(timings).toEqual({ "src/shared.e2e.test.ts": 450 });
  });

  test("rounds durations to whole milliseconds", () => {
    const timings = mergeTimings(
      [cache(["e2e:src/fast.e2e.test.ts", { duration: 99.6, failed: false }])],
      { vitestVersion },
    );

    expect(timings).toEqual({ "src/fast.e2e.test.ts": 100 });
  });

  test("orders the output by path so the committed file diffs cleanly", () => {
    const timings = mergeTimings(
      [
        cache(
          ["e2e:src/zeta.e2e.test.ts", { duration: 1, failed: false }],
          ["e2e:scripts/alpha.e2e.test.ts", { duration: 2, failed: false }],
          ["e2e:src/beta.e2e.test.ts", { duration: 3, failed: false }],
        ),
      ],
      { vitestVersion },
    );

    expect(Object.keys(timings)).toEqual([
      "scripts/alpha.e2e.test.ts",
      "src/beta.e2e.test.ts",
      "src/zeta.e2e.test.ts",
    ]);
  });

  test("rejects a cache written by a different Vitest major", () => {
    const stale: VitestResultsCache = {
      version: "4.2.1",
      results: [["e2e:src/a.e2e.test.ts", { duration: 1, failed: false }]],
    };

    expect(() => mergeTimings([stale], { vitestVersion })).toThrow(
      "results cache was written by Vitest 4.2.1 but Vitest 5.0.0 is installed",
    );
  });

  test("accepts a cache from a different minor of the same major", () => {
    const newer: VitestResultsCache = {
      version: "5.3.0",
      results: [["e2e:src/a.e2e.test.ts", { duration: 1, failed: false }]],
    };

    expect(mergeTimings([newer], { vitestVersion })).toEqual({ "src/a.e2e.test.ts": 1 });
  });
});
