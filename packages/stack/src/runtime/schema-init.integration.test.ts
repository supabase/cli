import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Redacted, Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- capture env-file contents before the scoped workspace is removed
import { readFileSync } from "node:fs";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { RequiresActivatedProcessError } from "../public/Errors.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import type {
  ContainerContainerSpec,
  ContainerEngine,
  ContainerNetworkSpec,
  ContainerResource,
  ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import { schemaInitContainerName } from "./ContainerRuntime.ts";
import { schemaInitWorkloads } from "./SchemaInit.ts";

interface FakeContainerState {
  resources: Array<ContainerResource>;
  calls: Array<string>;
  createdSpecs: Array<ContainerContainerSpec>;
  envFiles: Map<string, string>;
  nextId: number;
}

const fakeContainerEngine = (state: FakeContainerState): ContainerEngine => {
  const id = (prefix: string): string => `${prefix}-${state.nextId++}`;
  const find = (resourceId: string): ContainerResource | undefined =>
    state.resources.find((resource) => resource.id === resourceId);
  return {
    kind: "docker",
    preflight: Effect.succeed({ host: "host.docker.internal" }),
    probe: Effect.void,
    inspectImage: () => Effect.succeed({ present: true }),
    pullImage: () => Effect.void,
    listResources: () =>
      Effect.sync(() => {
        state.calls.push("list-resources");
        return [...state.resources];
      }),
    createNetwork: (spec: ContainerNetworkSpec) =>
      Effect.sync(() => {
        state.calls.push("create-network");
        const resource: ContainerResource = {
          id: id("network"),
          name: spec.name,
          kind: "network",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeNetwork: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`remove-network:${resourceId}`);
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
    createVolume: (spec: ContainerVolumeSpec) =>
      Effect.sync(() => {
        const resource: ContainerResource = {
          id: id("volume"),
          name: spec.name,
          kind: "volume",
          labels: spec.labels,
        };
        state.resources.push(resource);
        return resource;
      }),
    removeVolume: (resourceId: string) =>
      Effect.sync(() => {
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
    createContainer: (spec: ContainerContainerSpec) =>
      Effect.sync(() => {
        state.calls.push("create-container");
        if (spec.envFile !== undefined)
          state.envFiles.set(spec.envFile, readFileSync(spec.envFile, "utf8"));
        state.createdSpecs.push(spec);
        const resource: ContainerResource = {
          id: id("container"),
          name: spec.name,
          kind: spec.role,
          labels: spec.labels,
          state: "created",
        };
        state.resources.push(resource);
        return resource;
      }),
    copyToContainer: () => Effect.void,
    startContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`start:${resourceId}`);
        const resource = find(resourceId);
        if (resource !== undefined)
          state.resources = state.resources.map((entry) =>
            entry.id === resourceId ? { ...entry, state: "running" } : entry,
          );
      }),
    waitContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`wait:${resourceId}`);
        return 0;
      }),
    stopContainer: () => Effect.void,
    removeContainer: (resourceId: string) =>
      Effect.sync(() => {
        state.calls.push(`remove:${resourceId}`);
        state.resources = state.resources.filter((resource) => resource.id !== resourceId);
      }),
    streamLogs: () => Stream.empty,
  };
};

const fakePreparer: RuntimeArtifactPreparer = {
  prepare: (_runtime, workload: PlannedWorkload) =>
    Effect.succeed({
      workloadId: workload.id,
      capability: workload.capability,
      version: "1",
      outcome: "cached",
      artifactRoot: "/tmp/schema-init-artifact",
      executablePath: "bin/prepare",
      image: `example/${workload.capability}:1`,
    }),
};

const liveStackId = StackIdSchema.make("b".repeat(64));
const password = Redacted.make("s3cret");
const jwtSecret = Redacted.make("jwt-secret-value-that-is-long-enough");

const envFromFile = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

describe("schemaInit", () => {
  it.live("runs container one-shots with distinct names and empty publications", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "schema-init-live-" });
        const state: FakeContainerState = {
          resources: [
            {
              id: "net-live",
              name: "supabase-live-network",
              kind: "network",
              labels: {
                stackId: liveStackId,
                ownerSessionId: "owner-session",
                role: "network",
              },
            },
          ],
          calls: [],
          createdSpecs: [],
          envFiles: new Map(),
          nextId: 1,
        };
        yield* schemaInitWorkloads(
          ["auth"],
          {
            kind: "live",
            stackId: liveStackId,
            projectRoot,
            runtime: { kind: "container", engine: "docker" },
            config: {},
            databaseUrl: "postgresql://postgres:s3cret@127.0.0.1:54322/postgres",
            secrets: { databasePassword: password, jwtSecret },
          },
          { containerEngine: fakeContainerEngine(state), artifactPreparer: fakePreparer },
        );
        expect(state.createdSpecs).toHaveLength(1);
        const spec = state.createdSpecs[0];
        expect(spec).toBeDefined();
        if (spec === undefined) return;
        expect(spec.name.endsWith("-schema-init")).toBe(true);
        expect(spec.publications).toEqual([]);
        expect(spec.network).toBe("net-live");
        expect(spec.entrypoint).toBe("/usr/local/bin/auth");
        expect(spec.command).toEqual(["migrate"]);
        expect(spec.envFile).toBeDefined();
        if (spec.envFile === undefined) return;
        const env = envFromFile(state.envFiles.get(spec.envFile) ?? "");
        expect(env.GOTRUE_DB_DATABASE_URL).toContain("@supabase-database:5432/postgres");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rewrites ephemeral docker database endpoints to the published URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "schema-init-eph-" });
        const state: FakeContainerState = {
          resources: [],
          calls: [],
          createdSpecs: [],
          envFiles: new Map(),
          nextId: 1,
        };
        yield* schemaInitWorkloads(
          ["auth"],
          {
            kind: "ephemeral",
            projectRoot,
            runtime: { kind: "container", engine: "docker" },
            config: {},
            databaseUrl: "postgresql://postgres:s3cret@127.0.0.1:54322/postgres",
            secrets: { databasePassword: password, jwtSecret },
          },
          {
            containerEngine: fakeContainerEngine(state),
            artifactPreparer: fakePreparer,
            platform: "linux",
          },
        );
        expect(state.calls).toContain("create-network");
        const spec = state.createdSpecs[0];
        expect(spec).toBeDefined();
        if (spec === undefined) return;
        expect(spec.name).toBe(
          schemaInitContainerName({
            stackId: spec.labels.stackId,
            workloadId: "auth:auth",
          }),
        );
        expect(spec.network).not.toBe("net-live");
        expect(spec.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
        expect(spec.envFile).toBeDefined();
        if (spec.envFile === undefined) return;
        const env = envFromFile(state.envFiles.get(spec.envFile) ?? "");
        expect(env.GOTRUE_DB_DATABASE_URL).toContain("@host.docker.internal:54322/postgres");
        expect(env.GOTRUE_DB_DATABASE_URL).toContain("supabase_auth_admin");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("resolves pooler env without an activated pooler process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "schema-init-pooler-" });
        const state: FakeContainerState = {
          resources: [
            {
              id: "net-live",
              name: "supabase-live-network",
              kind: "network",
              labels: {
                stackId: liveStackId,
                ownerSessionId: "owner-session",
                role: "network",
              },
            },
          ],
          calls: [],
          createdSpecs: [],
          envFiles: new Map(),
          nextId: 1,
        };
        yield* schemaInitWorkloads(
          ["pooler"],
          {
            kind: "live",
            stackId: liveStackId,
            projectRoot,
            runtime: { kind: "container", engine: "docker" },
            config: {},
            databaseUrl: "postgresql://postgres:s3cret@127.0.0.1:54322/postgres",
            secrets: { databasePassword: password, jwtSecret },
          },
          { containerEngine: fakeContainerEngine(state), artifactPreparer: fakePreparer },
        );
        expect(state.createdSpecs).toHaveLength(2);
        expect(state.createdSpecs.map((spec) => spec.entrypoint)).toEqual([
          "/app/bin/prepare",
          "/app/bin/provision-tenant",
        ]);
        const envFile = state.createdSpecs[0]?.envFile;
        expect(envFile).toBeDefined();
        if (envFile === undefined) return;
        const env = envFromFile(state.envFiles.get(envFile) ?? "");
        expect(env.DATABASE_URL).toContain("@supabase-database:5432/_supabase");
        expect(env.POSTGRES_HOST).toBe("supabase-database");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("tags docker analytics as requiring an activated process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "schema-init-analytics-" });
        const state: FakeContainerState = {
          resources: [],
          calls: [],
          createdSpecs: [],
          envFiles: new Map(),
          nextId: 1,
        };
        const exit = yield* schemaInitWorkloads(
          ["analytics"],
          {
            kind: "ephemeral",
            projectRoot,
            runtime: { kind: "container", engine: "docker" },
            config: {},
            databaseUrl: "postgresql://postgres:s3cret@127.0.0.1:54322/postgres",
            secrets: { databasePassword: password, jwtSecret },
          },
          { containerEngine: fakeContainerEngine(state), artifactPreparer: fakePreparer },
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(RequiresActivatedProcessError);
        if (!(error instanceof RequiresActivatedProcessError)) return;
        expect(error.capability).toBe("analytics");
        expect(state.createdSpecs).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips a disabled capability without creating a one-shot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "schema-init-disabled-" });
        const state: FakeContainerState = {
          resources: [],
          calls: [],
          createdSpecs: [],
          envFiles: new Map(),
          nextId: 1,
        };
        yield* schemaInitWorkloads(
          ["analytics"],
          {
            kind: "ephemeral",
            projectRoot,
            runtime: { kind: "container", engine: "docker" },
            config: {
              capabilities: {
                analytics: { enabled: false },
                studio: { enabled: false },
              },
            },
            databaseUrl: "postgresql://postgres:s3cret@127.0.0.1:54322/postgres",
            secrets: { databasePassword: password, jwtSecret },
          },
          { containerEngine: fakeContainerEngine(state), artifactPreparer: fakePreparer },
        );
        expect(state.createdSpecs).toEqual([]);
        expect(state.calls.filter((call) => call === "create-container")).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
