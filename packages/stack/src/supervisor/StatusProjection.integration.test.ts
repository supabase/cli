import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { PersistedStackState } from "../state/StackState.ts";
import { compileStack } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import type { ObservedWorkload } from "../runtime/RuntimeDriver.ts";
import { ready } from "./CapabilityState.ts";
import type { SupervisorSnapshot } from "./SupervisorState.ts";
import { statusForSnapshot } from "./StatusProjection.ts";

const identity = {
  projectRoot: "/tmp/status-projection",
  branchContext: "ordinary-workspace",
  stackName: "status-projection",
} as const;

const snapshotFor = (): SupervisorSnapshot => {
  const sessionId = Symbol("session");
  return {
    stack: { _tag: "running" },
    sessionId,
    plan: undefined,
    capabilities: new Map([["studio", ready(sessionId, 0, false)]]),
  };
};

describe("status projection", () => {
  it.effect("retains later workload errors when an earlier failure has no text", () =>
    Effect.gen(function* () {
      const id = yield* deriveStackId(identity);
      const compiled = yield* compileStack({
        projectRoot: identity.projectRoot,
        runtime: { kind: "native" },
        config: {},
      });
      const state: PersistedStackState = {
        format: "supabase-stack-state-v1",
        identity,
        runtime: { kind: "native" },
        desiredLifecycle: "running",
        definition: compiled.definition,
        ports: [],
        privatePorts: [],
        secrets: {},
      };
      const observed: ReadonlyArray<ObservedWorkload> = [
        { stackId: id, workloadId: "studio:studio", state: "failed" },
        {
          stackId: id,
          workloadId: "studio:pgmeta",
          state: "failed",
          error: "pg-meta failed",
        },
      ];

      const status = yield* statusForSnapshot(
        id,
        state,
        { _tag: "available", workloads: observed },
        snapshotFor(),
      );
      const studio = status.capabilities.find((capability) => capability.name === "studio");

      expect(studio).toEqual({
        name: "studio",
        activation: "lazy",
        state: "failed",
        error: "studio:pgmeta: pg-meta failed",
      });

      const allFailures = yield* statusForSnapshot(
        id,
        state,
        {
          _tag: "available",
          workloads: [
            {
              stackId: id,
              workloadId: "studio:studio",
              state: "failed",
              error: "studio failed",
            },
            {
              stackId: id,
              workloadId: "studio:pgmeta",
              state: "failed",
              error: "pg-meta failed",
            },
          ],
        },
        snapshotFor(),
      );

      expect(allFailures.capabilities.find((capability) => capability.name === "studio")).toEqual({
        name: "studio",
        activation: "lazy",
        state: "failed",
        error: "studio:studio: studio failed; studio:pgmeta: pg-meta failed",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
