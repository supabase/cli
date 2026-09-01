import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { ArtifactRequest, ArtifactStore, PreparedArtifact } from "./ArtifactStore.ts";
import type {
  ContainerEngine,
  ContainerNetworkSpec,
  ContainerVolumeSpec,
  ContainerContainerSpec,
} from "../runtime/ContainerEngine.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  makeRuntimeArtifactPreparer,
} from "./RuntimeArtifacts.ts";

const nativeWorkload = (selected: PlannedWorkload["selected"]): PlannedWorkload => ({
  id: "database:database",
  capability: "database",
  dependencies: [],
  readiness: { mode: "tcp" },
  restart: { maxAttempts: 1, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", service: "postgres", release: "17.6.1.167" },
    container: {
      kind: "container",
      service: "postgres",
      image: "ghcr.io/supabase/cli/postgres:17.6.1.167",
    },
  },
  selected,
  specHash: "hash",
});

const prepared = (request: ArtifactRequest): PreparedArtifact => ({
  key: request.key,
  path: "/tmp/prepared-database",
  sha256: request.sha256,
  requiredRuntimePaths: request.requiredRuntimePaths,
  executablePath: request.executablePath,
  outcome: "downloaded",
});

const containerEngine = (present: boolean, calls: string[]): ContainerEngine => ({
  kind: "docker",
  executable: "docker",
  preflight: Effect.succeed({ host: "host.docker.internal" }),
  probe: Effect.sync(() => {
    calls.push("probe");
  }),
  inspectImage: (image) =>
    Effect.sync(() => {
      calls.push(`inspect:${image}`);
      return { present };
    }),
  pullImage: (image) =>
    Effect.sync(() => {
      calls.push(`pull:${image}`);
    }),
  listResources: () => Effect.succeed([]),
  createNetwork: (_spec: ContainerNetworkSpec) => Effect.die("unused"),
  removeNetwork: () => Effect.void,
  createVolume: (_spec: ContainerVolumeSpec) => Effect.die("unused"),
  removeVolume: () => Effect.void,
  createContainer: (_spec: ContainerContainerSpec) => Effect.die("unused"),
  copyToContainer: () => Effect.die("unused"),
  startContainer: () => Effect.void,
  waitContainer: () => Effect.succeed(0),
  stopContainer: () => Effect.void,
  removeContainer: () => Effect.void,
});

describe("runtime artifact preparation", () => {
  it.live("constructs only the persisted container engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-artifact-runtime-" });
        const preparer = yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: root,
          runtime: { kind: "container", engine: "podman" },
        });
        expect(preparer.containerEngine?.kind).toBe("podman");
        expect(yield* fs.exists(path.join(root, "artifacts"))).toBe(false);
        const native = yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: root,
          runtime: { kind: "native" },
        });
        expect(native.containerEngine).toBeUndefined();
        const sharedRoot = path.join(root, "shared-artifacts");
        const isolatedStateRoot = path.join(root, "isolated-state");
        yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: isolatedStateRoot,
          artifactCacheRoot: sharedRoot,
          runtime: { kind: "native" },
        });
        expect(yield* fs.exists(sharedRoot)).toBe(true);
        expect(yield* fs.exists(path.join(isolatedStateRoot, "artifacts"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("resolves native catalog metadata, checksum, and one ArtifactRequest", () => {
    const requests: ArtifactRequest[] = [];
    const store: ArtifactStore = {
      prepare: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return prepared(request);
        }),
    };
    const runtime = makeRuntimeArtifactPreparer({
      native: {
        store,
        checksum: () => Effect.succeed("a".repeat(64)),
        platform: { os: "darwin", arch: "arm64" },
      },
    });
    const result = Effect.runSync(
      runtime.prepare(
        { kind: "native" },
        nativeWorkload({ kind: "native", service: "postgres", release: "17.6.1.167" }),
      ),
    );
    expect(result.outcome).toBe("downloaded");
    expect(result.version).toBe("17.6.1.167");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toContain("slim-services/postgres/17.6.1.167/darwin-arm64");
    expect(requests[0]?.sha256).toBe("a".repeat(64));
  });

  it("probes and pulls an absent container image without creating or starting a container", () => {
    const calls: string[] = [];
    const engine = containerEngine(false, calls);
    const runtime = makeRuntimeArtifactPreparer({
      native: { store: { prepare: () => Effect.die("unused") } },
      containers: { docker: engine, podman: engine },
    });
    const result = Effect.runSync(
      runtime.prepare(
        { kind: "container", engine: "docker" },
        nativeWorkload({
          kind: "container",
          service: "postgres",
          image: "ghcr.io/supabase/cli/postgres:17.6.1.167",
        }),
      ),
    );
    expect(result.outcome).toBe("pulled");
    expect(calls).toEqual([
      "probe",
      "inspect:ghcr.io/supabase/cli/postgres:17.6.1.167",
      "pull:ghcr.io/supabase/cli/postgres:17.6.1.167",
    ]);
  });

  it("uses the persisted container engine identity", () => {
    const dockerCalls: string[] = [];
    const podmanCalls: string[] = [];
    const runtime = makeRuntimeArtifactPreparer({
      native: { store: { prepare: () => Effect.die("unused") } },
      containers: {
        docker: containerEngine(true, dockerCalls),
        podman: containerEngine(true, podmanCalls),
      },
    });
    Effect.runSync(
      runtime.prepare(
        { kind: "container", engine: "podman" },
        nativeWorkload({
          kind: "container",
          service: "postgres",
          image: "ghcr.io/supabase/cli/postgres:17.6.1.167",
        }),
      ),
    );
    expect(podmanCalls).toContain("probe");
    expect(dockerCalls).toEqual([]);
  });

  it("fails strict runtime/artifact mismatches before touching a store or engine", () => {
    let called = false;
    const runtime = makeRuntimeArtifactPreparer({
      native: {
        store: {
          prepare: () =>
            Effect.sync(() => {
              called = true;
              return prepared({ key: "x", sha256: "a".repeat(64), requiredRuntimePaths: [] });
            }),
        },
        checksum: () => Effect.succeed("a".repeat(64)),
      },
    });
    const exit = Effect.runSyncExit(
      runtime.prepare(
        { kind: "native" },
        nativeWorkload({
          kind: "container",
          service: "postgres",
          image: "ghcr.io/supabase/cli/postgres:17.6.1.167",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(called).toBe(false);
  });
});
