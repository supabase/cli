import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Stream } from "effect";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import {
  makeArtifactStore,
  type ArtifactRequest,
  type ArtifactSource,
  type ArtifactStore,
  type PreparedArtifact,
} from "./ArtifactStore.ts";
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
import { ContainerEngineError, StackPreparationError } from "../public/Errors.ts";
import { ContainerEngineProtocolError } from "../runtime/ContainerEngine.ts";
import { catalogReleaseFor } from "../model/WorkloadCatalog.ts";

const databaseRelease = catalogReleaseFor("database:database");
if (databaseRelease === undefined) throw new Error("Missing default database release");

const nativeWorkload = (selected: PlannedWorkload["selected"]): PlannedWorkload => ({
  id: "database:database",
  capability: "database",
  dependencies: [],
  readiness: {},
  artifacts: {
    native: { kind: "native", release: databaseRelease.version },
    container: {
      kind: "container",
      image: databaseRelease.containerImage,
    },
  },
  selected,
});

const prepared = (request: ArtifactRequest): PreparedArtifact => ({
  key: request.key,
  path: "/tmp/prepared-database",
  sha256: "a".repeat(64),
  requiredRuntimePaths: request.requiredRuntimePaths,
  executablePath: request.executablePath,
  outcome: "downloaded",
});

const archive = new TextEncoder().encode("archive");
const archiveSha256 = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";

const nativeSource = (): ArtifactSource => ({
  checksum: () => Effect.succeed(archiveSha256),
  materialize: (request, destination) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const relative of request.requiredRuntimePaths) {
        const target = path.join(destination, relative);
        if (relative === request.executablePath) {
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, "native executable");
        } else {
          yield* fs.makeDirectory(target, { recursive: true });
        }
      }
      return archive;
    }).pipe(
      Effect.mapError(
        (cause) => new StackPreparationError({ message: "native fixture failed", cause }),
      ),
    ),
});

const containerEngine = (
  present: boolean,
  calls: string[],
  kind: ContainerEngine["kind"] = "docker",
): ContainerEngine => ({
  kind,
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
  streamLogs: () => Stream.empty,
});

describe("runtime artifact preparation", () => {
  it.live("constructs only the persisted container engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-artifact-runtime-" });
        yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: root,
          runtime: { kind: "container", engine: "podman" },
        });
        expect(yield* fs.exists(path.join(root, "artifacts"))).toBe(false);
        yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: root,
          runtime: { kind: "native" },
        });
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

  it.live("surfaces selected-engine resolver failures as container engine errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-artifact-engine-" });
        const resolver = {
          resolve: () =>
            Effect.fail(
              new ContainerEngineProtocolError({
                operation: "probe",
                message: "podman is not installed",
              }),
            ),
        };
        const exit = yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: root,
          runtime: { kind: "container", engine: "podman" },
          containerEngineResolver: resolver,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        expect(error).toBeInstanceOf(ContainerEngineError);
        expect(error).toMatchObject({ engine: "podman" });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("resolves native catalog metadata and one ArtifactRequest", () => {
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
        platform: { os: "darwin", arch: "arm64" },
      },
    });
    const result = Effect.runSync(
      runtime.prepare(
        { kind: "native" },
        nativeWorkload({ kind: "native", release: databaseRelease.version }),
      ),
    );
    expect(result.outcome).toBe("downloaded");
    expect(result.version).toBe(databaseRelease.version);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toContain(
      `slim-services/postgres/${databaseRelease.version}/darwin-arm64`,
    );
  });

  it.live("reuses a published native artifact without contacting its source again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-artifact-offline-" });
        const firstStore = yield* makeArtifactStore({
          cacheRoot: root,
          source: nativeSource(),
        });
        const workload = nativeWorkload({
          kind: "native",
          release: databaseRelease.version,
        });
        const firstPreparer = makeRuntimeArtifactPreparer({
          native: {
            store: firstStore,
            platform: { os: "darwin", arch: "arm64" },
          },
        });
        const first = yield* firstPreparer.prepare({ kind: "native" }, workload);
        expect(first.outcome).toBe("downloaded");
        const offline: ArtifactSource = {
          checksum: () =>
            Effect.fail(new StackPreparationError({ message: "checksum network unavailable" })),
          materialize: () =>
            Effect.fail(new StackPreparationError({ message: "artifact network unavailable" })),
        };
        const secondStore = yield* makeArtifactStore({ cacheRoot: root, source: offline });
        const secondPreparer = makeRuntimeArtifactPreparer({
          native: {
            store: secondStore,
            platform: { os: "darwin", arch: "arm64" },
          },
        });
        const second = yield* secondPreparer.prepare({ kind: "native" }, workload);
        expect(second.outcome).toBe("cached");
        expect(second.artifactRoot).toBe(first.artifactRoot);
        expect(yield* fs.exists(`${first.artifactRoot}/.artifact.json`)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not trust malformed native cache metadata while offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-artifact-offline-invalid-",
        });
        const firstStore = yield* makeArtifactStore({
          cacheRoot: root,
          source: nativeSource(),
        });
        const workload = nativeWorkload({
          kind: "native",
          release: databaseRelease.version,
        });
        const preparer = makeRuntimeArtifactPreparer({
          native: {
            store: firstStore,
            platform: { os: "darwin", arch: "arm64" },
          },
        });
        const first = yield* preparer.prepare({ kind: "native" }, workload);
        yield* fs.writeFileString(`${first.artifactRoot}/.artifact.json`, "malformed");

        const offline: ArtifactSource = {
          checksum: () =>
            Effect.fail(new StackPreparationError({ message: "checksum network unavailable" })),
          materialize: () =>
            Effect.fail(new StackPreparationError({ message: "artifact network unavailable" })),
        };
        const secondStore = yield* makeArtifactStore({ cacheRoot: root, source: offline });
        const exit = yield* makeRuntimeArtifactPreparer({
          native: {
            store: secondStore,
            platform: { os: "darwin", arch: "arm64" },
          },
        })
          .prepare({ kind: "native" }, workload)
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        expect(error).toBeInstanceOf(StackPreparationError);
        expect(error).toMatchObject({ message: "checksum network unavailable" });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("probes and pulls an absent container image without creating or starting a container", () => {
    const calls: string[] = [];
    const engine = containerEngine(false, calls);
    const runtime = makeRuntimeArtifactPreparer({
      native: { store: { prepare: () => Effect.die("unused") } },
      containerEngine: engine,
    });
    const result = Effect.runSync(
      runtime.prepare(
        { kind: "container", engine: "docker" },
        nativeWorkload({
          kind: "container",
          image: databaseRelease.containerImage,
        }),
      ),
    );
    expect(result.outcome).toBe("pulled");
    expect(calls).toEqual([
      "probe",
      `inspect:${databaseRelease.containerImage}`,
      `pull:${databaseRelease.containerImage}`,
    ]);
  });

  it("uses the persisted container engine identity", () => {
    const podmanCalls: string[] = [];
    const runtime = makeRuntimeArtifactPreparer({
      native: { store: { prepare: () => Effect.die("unused") } },
      containerEngine: containerEngine(true, podmanCalls, "podman"),
    });
    Effect.runSync(
      runtime.prepare(
        { kind: "container", engine: "podman" },
        nativeWorkload({
          kind: "container",
          image: databaseRelease.containerImage,
        }),
      ),
    );
    expect(podmanCalls).toContain("probe");
  });

  it("reports unavailable container engines separately from artifact preparation", () => {
    const engine = containerEngine(true, []);
    const unavailable: ContainerEngine = {
      ...engine,
      probe: Effect.fail(
        new ContainerEngineProtocolError({
          operation: "probe",
          message: "docker daemon is unavailable",
        }),
      ),
    };
    const runtime = makeRuntimeArtifactPreparer({
      containerEngine: unavailable,
    });
    const exit = Effect.runSyncExit(
      runtime.prepare(
        { kind: "container", engine: "docker" },
        nativeWorkload({
          kind: "container",
          image: databaseRelease.containerImage,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error).toBeInstanceOf(ContainerEngineError);
    expect(error).toMatchObject({ engine: "docker", message: "docker daemon is unavailable" });
  });

  it("fails strict runtime/artifact mismatches before touching a store or engine", () => {
    let called = false;
    const runtime = makeRuntimeArtifactPreparer({
      native: {
        store: {
          prepare: () =>
            Effect.sync(() => {
              called = true;
              return prepared({ key: "x", requiredRuntimePaths: [] });
            }),
        },
      },
    });
    const exit = Effect.runSyncExit(
      runtime.prepare(
        { kind: "native" },
        nativeWorkload({
          kind: "container",
          image: databaseRelease.containerImage,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(called).toBe(false);
  });
});
