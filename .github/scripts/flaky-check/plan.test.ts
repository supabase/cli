import { describe, expect, test } from "bun:test";
import { matrix, plan, PlanError, WEEKLY_CRON } from "./plan.ts";

const dispatch = (
  overrides: Partial<{ suites: string; runs: string; repeats: string; filter: string }>,
) =>
  plan({
    event: "workflow_dispatch",
    suites: "unit",
    runs: "2",
    repeats: "4",
    filter: "",
    ...overrides,
  });

describe("plan", () => {
  test("the weekly schedule runs e2e suites three times and any other schedule runs unit and integration ten times", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(`${import.meta.dir}/../../workflows/flaky-check.yml`).text(),
    );
    const crons = JSON.stringify(workflow);
    expect(crons).toContain(`"cron":"${WEEKLY_CRON}"`);

    const weekly = plan({ event: "schedule", schedule: WEEKLY_CRON });
    expect([weekly.tests.length, weekly.e2e.length, weekly.stack.length]).toEqual([0, 15, 18]);
    expect(weekly.expected).toHaveLength(33);
    expect(weekly.e2e.slice(0, 5).map((entry) => entry.name)).toEqual([
      "flaky-e2e-cli1-run1",
      "flaky-e2e-cli2-run1",
      "flaky-e2e-cli3-run1",
      "flaky-e2e-cli4-run1",
      "flaky-e2e-cli-e2e-run1",
    ]);

    const nightly = plan({ event: "schedule", schedule: "17 3 * * *" });
    expect(nightly.suites).toEqual(["unit", "integration"]);
    expect(nightly.tests).toHaveLength(20);
    expect([nightly.e2e.length, nightly.stack.length, nightly.base]).toEqual([0, 0, "develop"]);
  });

  test("a labeled pull request adds focused runs that repeat against the PR base", () => {
    const result = plan({ event: "pull_request", baseRef: "next" });

    expect(result.suites).toEqual(["unit", "integration", "focused"]);
    expect(result.base).toBe("next");
    expect(
      result.tests.filter((entry) => entry.suite === "focused").map((entry) => entry.executions),
    ).toEqual(Array(10).fill(5));
  });

  test("a dispatch normalizes its inputs and orders suites canonically", () => {
    const result = dispatch({
      suites: " focused , unit ",
      runs: " 2",
      repeats: "9",
      filter: "  src/a.ts ",
    });

    expect(result.tests).toEqual([
      { suite: "unit", run: 1, name: "flaky-unit-run1", executions: 1 },
      { suite: "unit", run: 2, name: "flaky-unit-run2", executions: 1 },
      { suite: "focused", run: 1, name: "flaky-focused-run1", executions: 10 },
      { suite: "focused", run: 2, name: "flaky-focused-run2", executions: 10 },
    ]);
    expect(result.filter).toBe("src/a.ts");
    expect(matrix(result.e2e)).toBe("");
    expect(JSON.parse(matrix(result.tests)).include).toHaveLength(4);
  });

  test.each([
    [{ suites: "unit,bogus" }, "unknown suite 'bogus'"],
    [{ suites: " , " }, "no suites selected"],
    [{ runs: "31" }, "runs must be a whole number between 1 and 30, got '31'"],
    [{ runs: "1.5" }, "runs must be a whole number"],
    [{ repeats: "-1" }, "repeats must be a whole number between 0 and 100"],
  ])("rejects %j", (overrides, message) => {
    expect(() => dispatch(overrides)).toThrow(PlanError);
    expect(() => dispatch(overrides)).toThrow(message);
  });
});
