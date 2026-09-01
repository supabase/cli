import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import type {
  ContainerContainerSpec,
  ContainerEngine,
  ContainerNetworkLabels,
  ContainerNetworkSpec,
  ContainerResource,
  ContainerWorkloadLabels,
  ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import { makeContainerRuntime } from "./ContainerRuntime.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";

const stackId = StackIdSchema.make("e".repeat(64));
const otherStackId = StackIdSchema.make("f".repeat(64));
const artifact: ContainerArtifact = {
  kind: "container",
  image: "example/database:1",
};
const key: RuntimeWorkloadKey = {
  stackId,
  desiredGeneration: 3,
  workloadId: "database:database",
  specHash: "hash-current",
};
const workload = (selected: PlannedWorkload["selected"] = artifact): PlannedWorkload => ({
  id: key.workloadId,
  capability: "database",
  dependencies: [],
  readiness: { mode: "tcp" },
  restart: { maxAttempts: 1, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", release: "1" },
    container: artifact,
  },
  selected,
  specHash: key.specHash,
});

const processPlan = <A>(main: A) => ({ startup: [], main });

const planFor = (workloads: ReadonlyArray<PlannedWorkload>): ExecutionPlan => ({
  runtime: { kind: "native" },
  activation: {
    database: "eager",
    rest: "eager",
    auth: "eager",
    realtime: "eager",
    storage: "eager",
    functions: "eager",
    studio: "eager",
    mail: "eager",
    analytics: "eager",
    pooler: "eager",
  },
  startOrder: ["database"],
  stopOrder: ["database"],
  dependencies: {
    database: [],
    rest: [],
    auth: [],
    realtime: [],
    storage: [],
    functions: [],
    studio: [],
    mail: [],
    analytics: [],
    pooler: [],
  },
  routes: [],
  workloads,
});

interface EngineState {
  resources: Array<ContainerResource>;
  calls: Array<string>;
  nextId: number;
}

const makeEngine = (state: EngineState): ContainerEngine => {
  const next = (prefix: string) => `${prefix}-${state.nextId++}`;
  const find = (id: string) => state.resources.find((resource) => resource.id === id);
  return {
    kind: "docker",
    executable: "controlled",
    preflight: Effect.succeed({ host: "host.docker.internal" }),
    probe: Effect.void,
    inspectImage: () => Effect.succeed({ present: true }),
    pullImage: () => Effect.sync(() => state.calls.push("pull-image")),
    listResources: () => Effect.sync(() => [...state.resources]),
    createNetwork: (spec: ContainerNetworkSpec) =>
      Effect.sync(() => {
        state.calls.push("create-network");
        const resource: ContainerResource = {
          id: next("network"),
          name: spec.name,
          kind: "network",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeNetwork: (id) =>
      Effect.sync(() => {
        state.calls.push(`remove-network:${id}`);
        state.resources = state.resources.filter((resource) => resource.id !== id);
      }),
    createVolume: (spec: ContainerVolumeSpec) =>
      Effect.sync(() => {
        state.calls.push("create-volume");
        const resource: ContainerResource = {
          id: next("volume"),
          name: spec.name,
          kind: "volume",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeVolume: (id) =>
      Effect.sync(() => {
        state.calls.push(`remove-volume:${id}`);
        state.resources = state.resources.filter((resource) => resource.id !== id);
      }),
    createContainer: (spec: ContainerContainerSpec) =>
      Effect.sync(() => {
        state.calls.push(`create-${spec.role}`);
        const resource: ContainerResource = {
          id: next(spec.role),
          name: spec.name,
          kind: spec.role,
          labels: spec.labels,
          state: "created",
        };
        state.resources.push(resource);
        return resource;
      }),
    copyToContainer: () => Effect.void,
    startContainer: (id) =>
      Effect.sync(() => {
        state.calls.push(`start:${id}`);
        const resource = find(id);
        if (resource !== undefined)
          state.resources = state.resources.map((entry) =>
            entry.id === id ? { ...entry, state: "running" } : entry,
          );
      }),
    waitContainer: () => Effect.succeed(0),
    stopContainer: (id) =>
      Effect.sync(() => {
        state.calls.push(`stop:${id}`);
        const resource = find(id);
        if (resource !== undefined)
          state.resources = state.resources.map((entry) =>
            entry.id === id ? { ...entry, state: "stopped" } : entry,
          );
      }),
    removeContainer: (id) =>
      Effect.sync(() => {
        state.calls.push(`remove:${id}`);
        state.resources = state.resources.filter((resource) => resource.id !== id);
      }),
  };
};

const workloadLabels = (
  id: StackId,
  ownerSessionId: string,
  specHash: string,
): ContainerWorkloadLabels => ({
  stackId: id,
  ownerSessionId,
  desiredGeneration: key.desiredGeneration,
  workloadId: key.workloadId,
  specHash,
  role: "workload",
});

const networkLabels = (id: StackId, ownerSessionId: string): ContainerNetworkLabels => ({
  stackId: id,
  ownerSessionId,
  desiredGeneration: key.desiredGeneration,
  role: "network",
});

const networkName = `supabase-${stackId.slice(0, 16)}-${key.desiredGeneration}-network`;
const workloadName = `supabase-${stackId.slice(0, 16)}-${key.desiredGeneration}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-workload`;

describe("runtime recovery", () => {
  it.live("adopts exact old-session workload and network resources", () =>
    Effect.gen(function* () {
      const state: EngineState = {
        calls: [],
        nextId: 1,
        resources: [
          {
            id: "old-container",
            name: workloadName,
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "old-owner", key.specHash),
          },
          {
            id: "old-network",
            name: networkName,
            kind: "network",
            labels: networkLabels(stackId, "old-owner"),
          },
        ],
      };
      const runtime = yield* makeContainerRuntime({
        engine: makeEngine(state),
        ownerSessionId: "new-owner",
      });
      const ready = yield* runtime.start(key, workload());
      expect(ready.state).toBe("ready");
      expect(state.calls).toEqual([]);
      expect(yield* runtime.observe(stackId)).toEqual([{ ...key, state: "ready" }]);
    }),
  );

  it.live("replaces a stale old-session hash without touching the adopted network", () =>
    Effect.gen(function* () {
      const state: EngineState = {
        calls: [],
        nextId: 1,
        resources: [
          {
            id: "stale-container",
            name: workloadName,
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "old-owner", "hash-old"),
          },
          {
            id: "old-network",
            name: networkName,
            kind: "network",
            labels: networkLabels(stackId, "old-owner"),
          },
        ],
      };
      const runtime = yield* makeContainerRuntime({
        engine: makeEngine(state),
        ownerSessionId: "new-owner",
      });
      yield* runtime.start(key, workload());
      expect(state.calls).toEqual([
        "stop:stale-container",
        "remove:stale-container",
        "create-workload",
        "start:workload-1",
      ]);
      expect(state.resources.some((resource) => resource.id === "old-network")).toBe(true);
    }),
  );

  it.live("cleans exact stack containers before networks, retaining then destroying volumes", () =>
    Effect.gen(function* () {
      const volumeName = `supabase-${stackId}-${key.workloadId}-volume`;
      const state: EngineState = {
        calls: [],
        nextId: 1,
        resources: [
          {
            id: "workload",
            name: workloadName,
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "owner", key.specHash),
          },
          {
            id: "network",
            name: networkName,
            kind: "network",
            labels: networkLabels(stackId, "owner"),
          },
          {
            id: "volume",
            name: volumeName,
            kind: "volume",
            labels: { stackId, workloadId: key.workloadId, role: "volume" },
          },
          {
            id: "foreign",
            name: "foreign",
            kind: "workload",
            state: "running",
            labels: workloadLabels(otherStackId, "other-owner", key.specHash),
          },
        ],
      };
      const runtime = yield* makeContainerRuntime({
        engine: makeEngine(state),
        ownerSessionId: "new-owner",
      });
      yield* runtime.cleanup({ stackId, destroy: false });
      expect(state.calls.slice(0, 3)).toEqual([
        "stop:workload",
        "remove:workload",
        "remove-network:network",
      ]);
      expect(state.resources.some((resource) => resource.id === "volume")).toBe(true);
      expect(state.resources.some((resource) => resource.id === "foreign")).toBe(true);
      const callCount = state.calls.length;
      yield* runtime.cleanup({ stackId, destroy: false });
      expect(state.calls).toHaveLength(callCount);
      yield* runtime.cleanup({ stackId, destroy: true });
      expect(state.resources.some((resource) => resource.id === "volume")).toBe(false);
      expect(state.resources.some((resource) => resource.id === "foreign")).toBe(true);
    }),
  );

  it.live("recovers containers without starting and removes stale workloads", () =>
    Effect.gen(function* () {
      const state: EngineState = {
        calls: [],
        nextId: 1,
        resources: [
          {
            id: "current",
            name: workloadName,
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "old-owner", key.specHash),
          },
          {
            id: "current-duplicate",
            name: workloadName,
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "previous-owner", key.specHash),
          },
          {
            id: "stale-hash",
            name: "stale-hash",
            kind: "workload",
            state: "running",
            labels: workloadLabels(stackId, "old-owner", "hash-old"),
          },
          {
            id: "stale-generation",
            name: "stale-generation",
            kind: "workload",
            state: "running",
            labels: {
              ...workloadLabels(stackId, "old-owner", "hash-generation"),
              desiredGeneration: key.desiredGeneration - 1,
            },
          },
          {
            id: "unplanned",
            name: "unplanned",
            kind: "workload",
            state: "running",
            labels: {
              ...workloadLabels(stackId, "old-owner", "hash-unplanned"),
              workloadId: "storage:storage",
            },
          },
          {
            id: "current-network",
            name: networkName,
            kind: "network",
            labels: networkLabels(stackId, "old-owner"),
          },
          {
            id: "stale-network",
            name: "stale-network",
            kind: "network",
            labels: { ...networkLabels(stackId, "old-owner"), desiredGeneration: 2 },
          },
          {
            id: "volume",
            name: "persistent",
            kind: "volume",
            labels: { stackId, workloadId: key.workloadId, role: "volume" },
          },
          {
            id: "foreign",
            name: "foreign",
            kind: "workload",
            state: "running",
            labels: workloadLabels(otherStackId, "other-owner", key.specHash),
          },
        ],
      };
      const runtime = yield* makeContainerRuntime({
        engine: makeEngine(state),
        ownerSessionId: "new-owner",
      });
      const observed = yield* runtime.recover({
        stackId,
        desiredGeneration: key.desiredGeneration,
        desiredLifecycle: "running",
        plan: planFor([workload()]),
      });
      expect(observed).toEqual([{ ...key, state: "ready" }]);
      expect(
        state.calls.some((call) => call.startsWith("create-") || call.startsWith("start:")),
      ).toBe(false);
      expect(state.calls).toContain("stop:current-duplicate");
      expect(state.calls).toContain("remove:current-duplicate");
      expect(state.calls.slice(-1)).toEqual(["remove-network:stale-network"]);
      expect(state.resources.map((resource) => resource.id)).toEqual([
        "current",
        "current-network",
        "volume",
        "foreign",
      ]);
    }),
  );

  it.live("cleans only exact native resources and is idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed(
              processPlan({
                executable: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000)"],
              }),
            ),
          waitForReadiness: () => Effect.void,
        });
        const otherKey = { ...key, stackId: otherStackId };
        const nativeWorkload = workload({ kind: "native", release: "1" });
        yield* runtime.start(key, nativeWorkload);
        yield* runtime.start(otherKey, { ...nativeWorkload, id: otherKey.workloadId });
        yield* runtime.cleanup({ stackId, destroy: true });
        expect(yield* runtime.observe(stackId)).toEqual([]);
        expect((yield* runtime.observe(otherStackId)).length).toBe(1);
        yield* runtime.cleanup({ stackId, destroy: true });
        yield* runtime.cleanup({ stackId: otherStackId, destroy: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recovers native resources by stopping exact stack remnants without starting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let launches = 0;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.sync(() => {
              launches += 1;
              return processPlan({
                executable: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
            }),
          waitForReadiness: () => Effect.void,
        });
        const nativeWorkload = workload({ kind: "native", release: "1" });
        yield* runtime.start(key, nativeWorkload);
        const otherKey = { ...key, stackId: otherStackId };
        yield* runtime.start(otherKey, { ...nativeWorkload, id: otherKey.workloadId });
        expect(launches).toBe(2);
        expect(
          yield* runtime.recover({
            stackId,
            desiredGeneration: key.desiredGeneration,
            desiredLifecycle: "running",
            plan: planFor([]),
          }),
        ).toEqual([]);
        expect(launches).toBe(2);
        expect(yield* runtime.observe(stackId)).toEqual([]);
        expect((yield* runtime.observe(otherStackId)).length).toBe(1);
        yield* runtime.cleanup({ stackId: otherStackId, destroy: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
