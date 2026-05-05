import { describe, expect, test } from "vitest";
import { ServiceState } from "@supabase/process-compose";
import {
  projectStackState,
  projectStackStates,
  type StackServiceProjectionCatalog,
} from "./StackStateProjection.ts";

function rawState(name: string, status: ServiceState["status"], error: string | null = null) {
  return new ServiceState({
    name,
    status,
    pid: null,
    exitCode: null,
    restartCount: 0,
    startedAt: null,
    error,
  });
}

const projectionCatalog: StackServiceProjectionCatalog = new Map([
  ["postgres", { visibility: "public" }],
  [
    "postgres-init",
    {
      visibility: "internal",
      owner: "postgres",
      ownerStatusWhileActive: "Initializing",
    },
  ],
  ["auth", { visibility: "public" }],
]);

describe("projectStackStates", () => {
  test("omits internal helper services from public output", () => {
    const projected = projectStackStates(
      [
        rawState("postgres", "Healthy"),
        rawState("postgres-init", "Stopped"),
        rawState("auth", "Healthy"),
      ],
      projectionCatalog,
    );

    expect(projected.map((state) => state.name)).toEqual(["postgres", "auth"]);
  });

  test("shows owner as Initializing while helper is active", () => {
    const projected = projectStackStates(
      [
        rawState("postgres", "Starting"),
        rawState("postgres-init", "Running"),
        rawState("auth", "Pending"),
      ],
      projectionCatalog,
    );

    expect(projected.find((state) => state.name === "postgres")?.status).toBe("Initializing");
  });

  test("propagates helper failure to owner", () => {
    const projected = projectStackStates(
      [
        rawState("postgres", "Healthy"),
        rawState("postgres-init", "Failed", "init failed"),
        rawState("auth", "Healthy"),
      ],
      projectionCatalog,
    );

    const postgres = projected.find((state) => state.name === "postgres");
    expect(postgres?.status).toBe("Failed");
    expect(postgres?.error).toBe("init failed");
  });

  test("falls back to the owner raw state after helper completion", () => {
    const projected = projectStackState(
      "postgres",
      [rawState("postgres", "Healthy"), rawState("postgres-init", "Stopped")],
      projectionCatalog,
    );

    expect(projected?.status).toBe("Healthy");
  });
});
