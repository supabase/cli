import { describe, expect, test } from "vitest";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { Effect, Layer, SubscriptionRef } from "effect";
import { StackServiceState, type StackInfo, type StackServiceStatus } from "@supabase/stack/effect";
import { StartDashboardState } from "./dashboard-state.ts";
import { createStartDashboardModel } from "./dashboard.model.ts";

function state(name: string, status: StackServiceStatus) {
  return new StackServiceState({
    name,
    status: status as StackServiceState["status"],
    pid: null,
    exitCode: null,
    restartCount: 0,
    startedAt: null,
    error: null,
  });
}

describe("createStartDashboardModel", () => {
  const stackInfo: StackInfo = {
    url: "http://127.0.0.1:54321",
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    publishableKey: "pk",
    secretKey: "sk",
    anonJwt: "anon",
    serviceRoleJwt: "service-role",
    serviceEndpoints: {},
  };
  const dashboardStateLayer = Layer.effect(
    StartDashboardState,
    Effect.gen(function* () {
      return {
        stackInfoRef: yield* SubscriptionRef.make<StackInfo | null>(null),
        serviceStatesRef: yield* SubscriptionRef.make<ReadonlyArray<StackServiceState>>([]),
        phaseRef: yield* SubscriptionRef.make<"starting" | "running" | "failed" | "stopping">(
          "starting",
        ),
        errorRef: yield* SubscriptionRef.make<string | null>(null),
      };
    }),
  );

  test("creates dashboard-scoped writable and derived atoms", () => {
    const model = createStartDashboardModel(dashboardStateLayer);
    const registry = AtomRegistry.make();

    expect(registry.get(model.stackInfoAtom)).toBeNull();
    expect(registry.get(model.phaseAtom)).toBe("starting");

    registry.set(model.serviceStatesAtom, [
      state("postgres", "Initializing"),
      state("auth", "Healthy"),
    ]);

    expect(registry.get(model.displayStatesAtom).map((entry) => entry.name)).toEqual([
      "postgres",
      "auth",
    ]);
    expect(
      registry.get(model.displayStatesAtom).find((entry) => entry.name === "postgres")?.status,
    ).toBe("Initializing");
    expect(registry.get(model.allHealthyAtom)).toBe(false);
    registry.set(model.stackInfoAtom, stackInfo);
    expect(registry.get(model.showConnectionInfoAtom)).toBe(false);

    registry.set(model.phaseAtom, "running");
    expect(registry.get(model.statusLineAtom)).toContain("Interrupt to stop");
    expect(registry.get(model.showConnectionInfoAtom)).toBe(true);
  });

  test("shows the foreground failure message when startup fails", () => {
    const model = createStartDashboardModel(dashboardStateLayer);
    const registry = AtomRegistry.make();

    registry.set(model.errorAtom, "startup failed");
    registry.set(model.phaseAtom, "failed");

    expect(registry.get(model.statusLineAtom)).toContain("startup failed");
    expect(registry.get(model.allHealthyAtom)).toBe(false);
  });
});
