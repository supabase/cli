import { describe, expect, it } from "@effect/vitest";
import { WORKLOAD_CATALOG } from "../model/WorkloadCatalog.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { runtimeSpecFor } from "./WorkloadRuntimeSpec.ts";

const state: PersistedStackState = {
  format: "supabase-stack-state-v1",
  identity: {
    stackId: "stack-runtime-spec-test",
    projectRoot: "/tmp/supabase-runtime-spec",
    checkoutRoot: "/tmp/supabase-runtime-spec",
    workspaceId: "/tmp/supabase-runtime-spec",
    checkoutId: ".",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "runtime-spec",
  },
  runtime: { kind: "native" },
  desiredGeneration: 1,
  desiredLifecycle: "running",
  ports: [{ field: "database", port: 55432, intent: "exact" }],
  secrets: {
    "secret:database.internal.password": { policy: "managed", value: "postgres" },
  },
};

const planned = (id: string): PlannedWorkload => {
  const entry = WORKLOAD_CATALOG[id];
  if (entry === undefined) throw new Error(`Missing test catalog entry: ${id}`);
  const separator = id.indexOf(":");
  const capability = CAPABILITY_NAMES.find((name) => name === id.slice(0, separator));
  if (capability === undefined) throw new Error(`Missing test capability: ${id}`);
  const name = id.slice(separator + 1);
  return {
    id,
    capability,
    dependencies: [],
    readiness: { mode: "tcp" },
    restart: { maxAttempts: 1, backoffMs: 0 },
    artifacts: {
      native: { kind: "native", service: entry.service, release: entry.nativeVersion },
      container: { kind: "container", service: entry.service, image: entry.containerImage },
    },
    selected: { kind: "native", service: entry.service, release: entry.nativeVersion },
    specHash: `${capability}:${name}`,
  };
};

describe("workload runtime catalog", () => {
  it("provides private command, environment and readiness metadata for every workload", () => {
    for (const [index, id] of Object.keys(WORKLOAD_CATALOG).entries()) {
      const workload = planned(id);
      const spec = runtimeSpecFor(workload);
      expect(spec).toBeDefined();
      if (spec === undefined) continue;
      const port = 30_000 + index;
      expect(spec.containerPort).toBeGreaterThan(0);
      expect(spec.env(state, workload, port).SUPABASE_STACK_WORKLOAD).toBe(id);
      expect(spec.readiness.protocol).toMatch(/http|tcp/u);
      expect(spec.args(state, workload, port)).toBeInstanceOf(Array);
      expect(spec.cwd(state, workload)).toBeTruthy();
      expect(spec.privateEndpoint(port)).toEqual({ host: "127.0.0.1", port });
    }
  });
});
