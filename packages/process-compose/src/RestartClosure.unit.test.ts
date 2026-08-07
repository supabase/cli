import { describe, expect, it } from "vitest";
import { restartClosureFor, type RestartClosureGraph } from "./RestartClosure.ts";

const graph = (
  order: ReadonlyArray<string>,
  dependents: Readonly<Record<string, ReadonlyArray<string>>>,
): RestartClosureGraph => ({
  order,
  dependentsOf: (name) => dependents[name] ?? [],
});

describe("restartClosureFor", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly graph: RestartClosureGraph;
    readonly root: string;
    readonly active: ReadonlyArray<string>;
    readonly expected: ReadonlyArray<string>;
  }> = [
    {
      name: "keeps only the requested service when no dependent is active",
      graph: graph(["db", "api", "web"], { db: ["api"], api: ["web"] }),
      root: "db",
      active: [],
      expected: ["db"],
    },
    {
      name: "includes active direct dependents in dependency order",
      graph: graph(["db", "api", "worker"], { db: ["api", "worker"] }),
      root: "db",
      active: ["worker", "api"],
      expected: ["db", "api", "worker"],
    },
    {
      name: "preserves inactive connectors leading to an active descendant",
      graph: graph(["db", "gateway", "api", "web"], {
        db: ["gateway"],
        gateway: ["api"],
        api: ["web"],
      }),
      root: "db",
      active: ["web"],
      expected: ["db", "gateway", "api", "web"],
    },
    {
      name: "continues through active dependents to include active descendants",
      graph: graph(["db", "api", "web"], { db: ["api"], api: ["web"] }),
      root: "db",
      active: ["api", "web"],
      expected: ["db", "api", "web"],
    },
    {
      name: "handles shared connectors without duplicating diamond nodes",
      graph: graph(["db", "api", "worker", "web"], {
        db: ["api", "worker"],
        api: ["web"],
        worker: ["web"],
      }),
      root: "db",
      active: ["web"],
      expected: ["db", "api", "worker", "web"],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(restartClosureFor(testCase.graph, testCase.root, new Set(testCase.active))).toEqual(
        testCase.expected,
      );
    });
  }
});
