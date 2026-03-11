import { describe, expect, test } from "vitest";
import { toDisplayStates } from "../../../stack/display-states.ts";

function state(name: string, status: string) {
  return {
    name,
    status,
    pid: null,
    exitCode: null,
    restartCount: 0,
    startedAt: null,
    error: null,
  } as any;
}

describe("toDisplayStates", () => {
  test("filters out postgres-init", () => {
    const result = toDisplayStates([
      state("postgres", "Healthy"),
      state("postgres-init", "Stopped"),
      state("postgrest", "Healthy"),
      state("auth", "Healthy"),
    ]);
    expect(result.map((s) => s.name)).toEqual(["postgres", "postgrest", "auth"]);
  });

  test("shows postgres as Initializing while postgres-init is running", () => {
    const result = toDisplayStates([
      state("postgres", "Healthy"),
      state("postgres-init", "Running"),
      state("postgrest", "Pending"),
      state("auth", "Pending"),
    ]);
    const pg = result.find((s) => s.name === "postgres")!;
    expect(pg.status).toBe("Initializing");
  });

  test("shows parent as own status once init completes", () => {
    const result = toDisplayStates([
      state("postgres", "Healthy"),
      state("postgres-init", "Stopped"),
      state("auth", "Healthy"),
    ]);
    expect(result.find((s) => s.name === "postgres")!.status).toBe("Healthy");
    expect(result.find((s) => s.name === "auth")!.status).toBe("Healthy");
  });

  test("propagates failure from init service to parent", () => {
    const result = toDisplayStates([
      state("postgres", "Healthy"),
      state("postgres-init", "Failed"),
      state("auth", "Healthy"),
    ]);
    expect(result.find((s) => s.name === "postgres")!.status).toBe("Failed");
  });

  test("handles pending init services", () => {
    const result = toDisplayStates([
      state("postgres", "Starting"),
      state("postgres-init", "Pending"),
    ]);
    const pg = result.find((s) => s.name === "postgres")!;
    expect(pg.status).toBe("Initializing");
  });

  test("works with no internal services present", () => {
    const result = toDisplayStates([state("postgres", "Healthy"), state("postgrest", "Healthy")]);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(["postgres", "postgrest"]);
  });
});
