import { describe, expect, it } from "vitest";
import { stackHealthBudgets, withStartupHealthTimeout } from "./health-budgets.ts";

describe("stack health budgets", () => {
  it("translates wall-clock startup budgets without changing liveness", () => {
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresNative, 120_000)).toEqual({
      ...stackHealthBudgets.postgresNative,
      startupFailureThreshold: 240,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresDocker, 120_000)).toEqual({
      ...stackHealthBudgets.postgresDocker,
      startupFailureThreshold: 238,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresNative, 0)).toEqual({
      ...stackHealthBudgets.postgresNative,
      initialDelaySeconds: 0,
      startupFailureThreshold: 1,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresNative, 250)).toEqual({
      ...stackHealthBudgets.postgresNative,
      initialDelaySeconds: 0,
      startupFailureThreshold: 1,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresDocker, 0)).toEqual({
      ...stackHealthBudgets.postgresDocker,
      initialDelaySeconds: 0,
      startupFailureThreshold: 1,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresDocker, 500)).toEqual({
      ...stackHealthBudgets.postgresDocker,
      initialDelaySeconds: 0.5,
      startupFailureThreshold: 1,
    });
    expect(withStartupHealthTimeout(stackHealthBudgets.postgresNative, undefined)).toBe(
      stackHealthBudgets.postgresNative,
    );
  });

  it("records startup and liveness policy for every health-checked service", () => {
    const summarized = Object.fromEntries(
      Object.entries(stackHealthBudgets).map(([name, budget]) => [
        name,
        {
          initialDelay: budget.initialDelaySeconds,
          period: budget.periodSeconds,
          startupThreshold: budget.startupFailureThreshold,
          startupBudget:
            budget.initialDelaySeconds + budget.periodSeconds * budget.startupFailureThreshold,
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
          "startupBudget": 130,
          "startupThreshold": 120,
        },
        "auth": {
          "initialDelay": 0,
          "livenessThreshold": 20,
          "period": 0.5,
          "startupBudget": 30,
          "startupThreshold": 60,
        },
        "edgeRuntime": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "imgproxy": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "mailpit": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "pgmeta": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "pooler": {
          "initialDelay": 2,
          "livenessThreshold": 60,
          "period": 1,
          "startupBudget": 92,
          "startupThreshold": 90,
        },
        "postgresDocker": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 61,
          "startupThreshold": 120,
        },
        "postgresNative": {
          "initialDelay": 0,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 60,
          "startupThreshold": 120,
        },
        "postgrest": {
          "initialDelay": 0,
          "livenessThreshold": 20,
          "period": 0.5,
          "startupBudget": 30,
          "startupThreshold": 60,
        },
        "realtime": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "storage": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 0.5,
          "startupBudget": 31,
          "startupThreshold": 60,
        },
        "studio": {
          "initialDelay": 2,
          "livenessThreshold": 60,
          "period": 1,
          "startupBudget": 92,
          "startupThreshold": 90,
        },
        "vector": {
          "initialDelay": 1,
          "livenessThreshold": 30,
          "period": 1,
          "startupBudget": 61,
          "startupThreshold": 60,
        },
      }
    `);
  });
});
