import { describe, expect, it } from "vitest";
import {
  dependencyTimeoutSecondsForServices,
  healthStartupBudgetSeconds,
  stackHealthBudgets,
  stackServiceStartupBudgetSeconds,
} from "./health-budgets.ts";

describe("stack health budgets", () => {
  it("records startup and liveness policy for every health-checked service", () => {
    const summarized = Object.fromEntries(
      Object.entries(stackHealthBudgets).map(([name, budget]) => [
        name,
        {
          initialDelay: budget.initialDelaySeconds,
          period: budget.periodSeconds,
          startupThreshold: budget.startupFailureThreshold,
          startupBudget: healthStartupBudgetSeconds(budget),
          livenessThreshold: budget.failureThreshold,
        },
      ]),
    );

    expect(summarized).toMatchInlineSnapshot(`
      {
        "analytics": {
          "initialDelay": 10,
          "livenessThreshold": 60,
          "period": 1,
          "startupBudget": 369,
          "startupThreshold": 120,
        },
        "auth": {
          "initialDelay": 0,
          "livenessThreshold": 20,
          "period": 0.5,
          "startupBudget": 149.5,
          "startupThreshold": 60,
        },
        "edgeRuntime": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "imgproxy": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "mailpit": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "pgmeta": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "pooler": {
          "initialDelay": 2,
          "livenessThreshold": 60,
          "period": 1,
          "startupBudget": 271,
          "startupThreshold": 90,
        },
        "postgresDocker": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 300.5,
          "startupThreshold": 120,
        },
        "postgresNative": {
          "initialDelay": 0,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 299.5,
          "startupThreshold": 120,
        },
        "postgrest": {
          "initialDelay": 0,
          "livenessThreshold": 20,
          "period": 0.5,
          "startupBudget": 149.5,
          "startupThreshold": 60,
        },
        "realtime": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "storage": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 150.5,
          "startupThreshold": 60,
        },
        "studio": {
          "initialDelay": 2,
          "livenessThreshold": 60,
          "period": 1,
          "startupBudget": 271,
          "startupThreshold": 90,
        },
        "vector": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 1,
          "startupBudget": 180,
          "startupThreshold": 60,
        },
      }
    `);
  });

  it("keeps dependency timeouts beyond each dependency startup path", () => {
    expect(dependencyTimeoutSecondsForServices(["postgres"])).toBeGreaterThan(
      stackServiceStartupBudgetSeconds.postgres,
    );
    expect(dependencyTimeoutSecondsForServices(["postgres", "storage"])).toBeGreaterThan(
      stackServiceStartupBudgetSeconds.postgres + stackServiceStartupBudgetSeconds.storage,
    );
    expect(dependencyTimeoutSecondsForServices(["postgres", "analytics"])).toBeGreaterThan(
      stackServiceStartupBudgetSeconds.postgres + stackServiceStartupBudgetSeconds.analytics,
    );
  });
});
