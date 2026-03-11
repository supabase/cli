import { describe, expect, test } from "vitest";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { Effect, Layer, SubscriptionRef } from "effect";
import { StackServiceState, type StackServiceStatus } from "@supabase/stack";
import type { StackInfo } from "@supabase/stack/internals";
import { StartDashboardState } from "./dashboard-state.ts";

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

  test("creates dashboard-scoped writable and derived atoms", async () => {
    const modelModule = await import("./dashboard.model.ts");
    expect("createStartDashboardModel" in modelModule).toBe(true);
    if (!("createStartDashboardModel" in modelModule)) return;

    const model = modelModule.createStartDashboardModel(dashboardStateLayer);
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

    registry.set(model.phaseAtom, "running");
    expect(registry.get(model.statusLineAtom)).toContain("Interrupt to stop");
  });

  test("shows the foreground failure message when startup fails", async () => {
    const modelModule = await import("./dashboard.model.ts");
    expect("createStartDashboardModel" in modelModule).toBe(true);
    if (!("createStartDashboardModel" in modelModule)) return;

    const model = modelModule.createStartDashboardModel(dashboardStateLayer);
    const registry = AtomRegistry.make();

    registry.set(model.errorAtom, "startup failed");
    registry.set(model.phaseAtom, "failed");

    expect(registry.get(model.statusLineAtom)).toContain("startup failed");
    expect(registry.get(model.allHealthyAtom)).toBe(false);
  });
});
