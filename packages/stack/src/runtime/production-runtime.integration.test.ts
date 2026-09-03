// oxlint-disable effecttsgo/prefer-schema-over-json -- generated shell fixtures use protocol JSON quoting, not product serialization.
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  Crypto,
  Redacted,
  Schema,
  Option,
  Stream,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer as createNetServer } from "node:net";
import type { StackLogEntry } from "../public/Logs.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import { NetworkPortSchema } from "../public/Status.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import type { LifecycleInput } from "../supervisor/Lifecycle.ts";
import {
  makeProductionRuntimeFactory,
  NATIVE_DATABASE_MIGRATION_MARKER,
  readinessDeadlineFor,
  withOwnedRuntimeFileCleanup,
} from "./ProductionRuntime.ts";
import { RuntimeDriverError, type RuntimeDriver } from "./RuntimeDriver.ts";
import {
  InvalidStackConfigError,
  PortUnavailableError,
  StackPreparationError,
} from "../public/Errors.ts";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { compileStack } from "../model/Compiler.ts";
import type {
  ContainerContainerSpec,
  ContainerEngine,
  ContainerResource,
  ContainerNetworkSpec,
  ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import type { RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import { makeRuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";

const stackId = StackIdSchema.make("a".repeat(64));

const stateFor = (
  secrets: PersistedStackState["secrets"],
  runtime: StackRuntime = { kind: "native" },
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    stackId,
    projectRoot: "/tmp/production-runtime",
    checkoutRoot: "/tmp/production-runtime",
    workspaceId: "/tmp/production-runtime",
    checkoutId: "/tmp/production-runtime",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "production-runtime",
  },
  runtime,
  desiredLifecycle: "stopped",
  ports: [],
  privatePorts: [],
  secrets,
});

const workloadFor = (
  id: string,
  capability: PlannedWorkload["capability"],
  selected: PlannedWorkload["selected"],
): PlannedWorkload => ({
  id,
  capability,
  dependencies: [],
  readiness: { mode: "tcp" },
  artifacts: {
    native: { kind: "native", release: "17.6.1.167" },
    container: {
      kind: "container",
      image: "ghcr.io/supabase/cli/postgres:17.6.1.167",
    },
  },
  selected,
});

const stateStoreFor = (
  current: { value: PersistedStackState },
  onRead?: () => void,
): StackStateStore => ({
  read: () =>
    Effect.sync(() => {
      onRead?.();
      return current.value;
    }),
  initialize: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  replaceUnlocked: () => Effect.die("unused"),
  cleanup: () => Effect.die("unused"),
});

const memoryLogStore = (entries: StackLogEntry[]): LogStore => ({
  path: "memory://production-runtime",
  append: (record) =>
    Effect.sync(() => {
      const entry: StackLogEntry = {
        cursor: { opaque: `v1_${entries.length + 1}` },
        timestamp: record.timestamp ?? "2026-01-01T00:00:00.000Z",
        source: record.source,
        stream: record.stream,
        message: record.message,
      };
      entries.push(entry);
      return entry;
    }),
  read: () => Effect.succeed(entries),
  stream: () => Stream.fromIterable(entries),
});

const ingress: SupervisorIngress = {
  acquire: () => Effect.die("unused"),
  open: () => Effect.die("unused"),
  close: Effect.void,
};

const artifacts: RuntimeArtifactPreparer = {
  prepare: () => Effect.die("unused"),
};

const writeNativeDatabaseFixture = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  eventsPath: string,
  failFirstMigration = false,
) =>
  Effect.gen(function* () {
    const initDirectory = path.join(root, "share/supabase-cli/bin");
    const migrationDirectory = path.join(root, "share/supabase-cli/migrations");
    yield* fs.makeDirectory(initDirectory, { recursive: true });
    yield* fs.makeDirectory(migrationDirectory, { recursive: true });
    const main = path.join(initDirectory, "supabase-postgres-init.sh");
    yield* fs.writeFileString(
      main,
      "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    yield* fs.chmod(main, 0o755);
    const migrate = path.join(migrationDirectory, "migrate.sh");
    const firstMigrationPath = `${eventsPath}.migration-attempted`;
    yield* fs.writeFileString(
      migrate,
      `#!/bin/sh
set -eu
${failFirstMigration ? `if [ ! -e ${JSON.stringify(firstMigrationPath)} ]; then touch ${JSON.stringify(firstMigrationPath)}; exit 7; fi` : ""}
printf 'migration|host=%s|port=%s|db=%s|user=%s|password=%s|path=%s\\n' "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DB" "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$PATH" >> ${JSON.stringify(eventsPath)}
`,
    );
    yield* fs.chmod(migrate, 0o755);
    return { main, migrate };
  });

const writeNativeRealtimeFixture = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  eventsPath: string,
) =>
  Effect.gen(function* () {
    const bin = path.join(root, "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    const migrate = path.join(bin, "migrate");
    yield* fs.writeFileString(
      migrate,
      `#!/bin/sh
printf 'realtime-migrate|RELEASE_DISTRIBUTION=%s\\n' "\${RELEASE_DISTRIBUTION:-missing}" >> ${JSON.stringify(eventsPath)}
`,
    );
    yield* fs.chmod(migrate, 0o755);
    const realtime = path.join(bin, "realtime");
    yield* fs.writeFileString(realtime, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(realtime, 0o755);
    const server = path.join(bin, "server");
    yield* fs.writeFileString(
      server,
      "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    yield* fs.chmod(server, 0o755);
    return { migrate, realtime, server };
  });

const listenForNativeReadiness = (
  server: ReturnType<typeof createNetServer> | ReturnType<typeof createServer>,
) =>
  Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      server.once("error", (error: Error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        if (!server.listening) return resume(Effect.void);
        server.close(() => resume(Effect.void));
      }),
  );

const envFiles: RuntimeEnvFileOwner = {
  write: () => Effect.die("unused"),
  cleanupAll: Effect.void,
};

const bootstrap: FunctionsBootstrapOwner = {
  write: () => Effect.die("unused"),
  cleanupAll: Effect.void,
};

const ownerInputContainerEngine = (
  createdSpecs: ContainerContainerSpec[],
  copiedFiles: Array<Readonly<{ source: string; destination: string }>> = [],
): ContainerEngine => {
  const resources: ContainerResource[] = [];
  const oneShot = new Set<string>();
  let nextId = 1;
  const resource = (
    kind: ContainerResource["kind"],
    name: string,
    labels: ContainerResource["labels"],
  ): ContainerResource => ({
    id: `${kind}-${nextId++}`,
    name,
    kind,
    labels,
    ...(kind === "workload" ? { state: "created" as const } : {}),
  });
  const updateState = (id: string, state: "running" | "stopped") => {
    const index = resources.findIndex((entry) => entry.id === id);
    const entry = resources[index];
    if (entry !== undefined) resources[index] = { ...entry, state };
  };
  return {
    kind: "docker",
    executable: "test-container-engine",
    preflight: Effect.sync(() => {
      return { host: "host.docker.internal" };
    }),
    probe: Effect.void,
    inspectImage: () => Effect.succeed({ present: true }),
    pullImage: () => Effect.void,
    listResources: () => Effect.sync(() => [...resources]),
    createNetwork: (spec: ContainerNetworkSpec) =>
      Effect.sync(() => {
        const created = resource("network", spec.name, spec.labels);
        resources.push(created);
        return created;
      }),
    removeNetwork: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    createVolume: (spec: ContainerVolumeSpec) =>
      Effect.sync(() => {
        const created = resource("volume", spec.name, spec.labels);
        resources.push(created);
        return created;
      }),
    removeVolume: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    createContainer: (spec) =>
      Effect.sync(() => {
        createdSpecs.push(spec);
        const created = resource("workload", spec.name, spec.labels);
        if (
          spec.entrypoint?.startsWith("/app/bin/") ||
          spec.command?.includes("migrate") ||
          spec.command?.join(" ").includes("eval") ||
          spec.entrypoint === "/node/bin/node"
        )
          oneShot.add(created.id);
        resources.push(created);
        return created;
      }),
    copyToContainer: (_id, source, destination) =>
      Effect.sync(() => {
        copiedFiles.push({ source, destination });
      }),
    startContainer: (id) =>
      Effect.sync(() => {
        updateState(id, "running");
      }),
    waitContainer: (id) => (oneShot.has(id) ? Effect.succeed(0) : Effect.never),
    stopContainer: (id) => Effect.sync(() => updateState(id, "stopped")),
    removeContainer: (id) =>
      Effect.sync(() => {
        const index = resources.findIndex((entry) => entry.id === id);
        if (index >= 0) resources.splice(index, 1);
      }),
    streamLogs: () => Stream.empty,
  };
};

describe("production runtime composition", () => {
  it.live("retries a transient database bootstrap connection failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-bootstrap-",
        });
        const readinessServer = createNetServer((socket) => socket.end());
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Database readiness server did not expose an address");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
        });
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "database:database", binding: "primary", port: address.port },
            ],
          },
        } satisfies { value: PersistedStackState };
        const database = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "database:database",
        );
        if (database === undefined) return yield* Effect.die("Expected database workload");
        const createdSpecs: ContainerContainerSpec[] = [];
        let attempts = 0;
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: ownerInputContainerEngine(createdSpecs),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(
                  new DatabaseBootstrapError({
                    message: "Database is still accepting connections",
                    retryable: true,
                  }),
                )
              : Effect.void;
          },
        });
        const runtime = yield* factory.make(current.value);
        const ready = yield* runtime.driver.start(
          {
            stackId,
            workloadId: database.id,
          },
          database,
        );
        expect(ready.state).toBe("ready");
        expect(attempts).toBe(2);
        yield* runtime.driver.stop({
          stackId,
          workloadId: database.id,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not retry non-retryable database bootstrap failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-bootstrap-fail-",
        });
        const readinessServer = createNetServer((socket) => socket.end());
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Database readiness server did not expose an address");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
        });
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "database:database", binding: "primary", port: address.port },
            ],
          },
        } satisfies { value: PersistedStackState };
        const database = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "database:database",
        );
        if (database === undefined) return yield* Effect.die("Expected database workload");
        let attempts = 0;
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: ownerInputContainerEngine([]),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => {
            attempts += 1;
            return Effect.fail(new DatabaseBootstrapError({ message: "invalid password" }));
          },
        });
        const runtime = yield* factory.make(current.value);
        const result = yield* runtime.driver
          .start(
            {
              stackId,
              workloadId: database.id,
            },
            database,
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(attempts).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("activates a capability through its public listener workload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-activation-endpoint-",
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              database: {},
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: {
                enabled: true,
                settings: { image_transformation: { enabled: true } },
              },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const current = {
          value: {
            ...stateFor({}),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "storage:imgproxy", binding: "primary", port: 41_001 },
              { workloadId: "storage:storage", binding: "primary", port: 41_002 },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: artifacts,
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const input = {
          stackId,
          desiredLifecycle: "running" as const,
          state: current.value,
          definition: compiled.definition,
          secrets: current.value.secrets,
          plan: compiled.executionPlan,
        } satisfies LifecycleInput;
        if (runtime.activate === undefined) return yield* Effect.die("activation seam missing");
        const endpoint = yield* runtime.activate("storage", input);
        expect(endpoint).toEqual({ host: "127.0.0.1", port: 41_002 });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("propagates native BEAM environment to a realtime startup process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-beam-" });
        const eventsPath = path.join(root, "events");
        const artifactRoot = path.join(root, "artifact");
        yield* writeNativeRealtimeFixture(fs, path, artifactRoot, eventsPath);
        const readinessServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Realtime readiness server did not expose an address");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              database: {},
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: true },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const current = {
          value: {
            ...stateFor({
              "secret:database.internal.password": { policy: "managed", value: "db-secret" },
              "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
            }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "realtime:realtime", binding: "primary", port: address.port },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: {
            prepare: () =>
              Effect.succeed({
                workloadId: "realtime:realtime",
                capability: "realtime" as const,
                version: "v2.130.0",
                outcome: "cached" as const,
                artifactRoot,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const realtime = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "realtime:realtime",
        );
        if (realtime === undefined) return yield* Effect.die("Expected Realtime workload");
        const key = {
          stackId,
          workloadId: realtime.id,
        };
        const ready = yield* runtime.driver.start(key, realtime);
        expect(ready.state).toBe("ready");
        expect(yield* fs.readFileString(eventsPath)).toContain(
          "realtime-migrate|RELEASE_DISTRIBUTION=none",
        );
        yield* runtime.driver.stop(key);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("runs canonical PostgreSQL migrations before bootstrap on first native boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-pg-first-" });
        const eventsPath = path.join(root, "events");
        const artifactRoot = path.join(root, "artifact");
        yield* writeNativeDatabaseFixture(fs, path, artifactRoot, eventsPath);
        const readinessServer = createNetServer((socket) => socket.end());
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Native readiness server did not expose an address");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const current = {
          value: {
            ...stateFor({
              "secret:database.internal.password": { policy: "managed", value: "db-secret" },
              "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
            }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "database:database", binding: "primary", port: address.port },
            ],
          },
        } satisfies { value: PersistedStackState };
        const runtimePaths = yield* resolveStackPaths({ stateRoot: root, stackId });
        const databaseDataPath = path.join(runtimePaths.data, "database");
        const bootstrap = () =>
          Effect.gen(function* () {
            const previous = yield* fs.readFileString(eventsPath);
            yield* fs.writeFileString(eventsPath, `${previous}bootstrap\n`);
          }).pipe(
            Effect.mapError(
              (cause) => new StackPreparationError({ message: "bootstrap fixture failed", cause }),
            ),
          );
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: {
            prepare: () =>
              Effect.succeed({
                workloadId: "database:database",
                capability: "database" as const,
                version: "17.6.1.167",
                outcome: "cached" as const,
                artifactRoot,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: bootstrap,
        });
        const runtime = yield* factory.make(current.value);
        const database = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "database:database",
        );
        if (database === undefined) return yield* Effect.die("Expected database workload");
        const ready = yield* runtime.driver.start(
          {
            stackId,
            workloadId: database.id,
          },
          database,
        );
        expect(ready.state).toBe("ready");
        expect(
          yield* fs.exists(path.join(databaseDataPath, NATIVE_DATABASE_MIGRATION_MARKER)),
        ).toBe(true);
        const events = yield* fs.readFileString(eventsPath);
        expect(events).toContain("migration|host=127.0.0.1");
        expect(events).toContain("port=" + String(address.port));
        expect(events).toContain("db=postgres");
        expect(events).toContain("user=supabase_admin");
        expect(events).toContain("password=db-secret");
        expect(events).toContain(`path=${path.join(artifactRoot, "bin")}:`);
        expect(events.indexOf("migration")).toBeLessThan(events.indexOf("bootstrap"));
        yield* runtime.driver.stop({
          stackId,
          workloadId: database.id,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "retries canonical PostgreSQL migrations when PG_VERSION exists without completion marker",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-production-pg-existing-",
          });
          const eventsPath = path.join(root, "events");
          const artifactRoot = path.join(root, "artifact");
          yield* writeNativeDatabaseFixture(fs, path, artifactRoot, eventsPath, true);
          const readinessServer = createNetServer((socket) => socket.end());
          yield* listenForNativeReadiness(readinessServer);
          const address = readinessServer.address();
          if (typeof address !== "object" || address === null)
            return yield* Effect.die("Native readiness server did not expose an address");
          const compiled = yield* compileStack({
            projectRoot: root,
            runtime: { kind: "native" },
          });
          const current = {
            value: {
              ...stateFor({
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              }),
              identity: {
                ...stateFor({}).identity,
                projectRoot: root,
                checkoutRoot: root,
                workspaceId: root,
                checkoutId: root,
              },
              desiredLifecycle: "running" as const,
              definition: compiled.definition,
              privatePorts: [
                { workloadId: "database:database", binding: "primary", port: address.port },
              ],
            },
          } satisfies { value: PersistedStackState };
          const runtimePaths = yield* resolveStackPaths({ stateRoot: root, stackId });
          const databaseDataPath = path.join(runtimePaths.data, "database");
          yield* fs.makeDirectory(databaseDataPath, { recursive: true });
          yield* fs.writeFileString(path.join(databaseDataPath, "PG_VERSION"), "17\n");
          // A completed initdb has both PG_VERSION and postmaster.opts. The
          // missing migration marker must not erase its durable contents.
          yield* fs.writeFileString(path.join(databaseDataPath, "postmaster.opts"), "postgres\n");
          const durableMarker = path.join(databaseDataPath, "durable-user-data");
          yield* fs.writeFileString(durableMarker, "preserve-me");
          const bootstrap = () =>
            Effect.gen(function* () {
              const previous = yield* fs
                .readFileString(eventsPath)
                .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
              yield* fs.writeFileString(eventsPath, `${previous}bootstrap\n`);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({ message: "bootstrap fixture failed", cause }),
              ),
            );
          const context = yield* Effect.context<
            FileSystem.FileSystem | Path.Path | Crypto.Crypto
          >();
          const factory = yield* makeProductionRuntimeFactory({
            stateRoot: root,
            stackId,
            ownerSessionId: "owner",
            stateStore: stateStoreFor(current),
            context,
            ingress,
            artifactPreparer: {
              prepare: () =>
                Effect.succeed({
                  workloadId: "database:database",
                  capability: "database" as const,
                  version: "17.6.1.167",
                  outcome: "cached" as const,
                  artifactRoot,
                }),
            },
            logStore: memoryLogStore([]),
            bootstrapDatabase: bootstrap,
          });
          const runtime = yield* factory.make(current.value);
          const database = compiled.executionPlan.workloads.find(
            (workload) => workload.id === "database:database",
          );
          if (database === undefined) return yield* Effect.die("Expected database workload");
          const failed = yield* runtime.driver
            .start(
              {
                stackId,
                workloadId: database.id,
              },
              database,
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(failed)).toBe(true);
          expect(yield* fs.readFileString(durableMarker)).toBe("preserve-me");
          expect(
            yield* fs.exists(path.join(databaseDataPath, NATIVE_DATABASE_MIGRATION_MARKER)),
          ).toBe(false);
          yield* runtime.driver.start(
            {
              stackId,
              workloadId: database.id,
            },
            database,
          );
          const events = yield* fs.readFileString(eventsPath);
          expect(events).toContain("migration|host=127.0.0.1");
          expect(events).toContain("bootstrap\n");
          expect(
            yield* fs.exists(path.join(databaseDataPath, NATIVE_DATABASE_MIGRATION_MARKER)),
          ).toBe(true);
          yield* runtime.driver.stop({
            stackId,
            workloadId: database.id,
          });
          yield* fs.writeFileString(eventsPath, "");
          yield* runtime.driver.start(
            {
              stackId,
              workloadId: database.id,
            },
            database,
          );
          expect(yield* fs.readFileString(eventsPath)).toBe("bootstrap\n");
          yield* runtime.driver.stop({
            stackId,
            workloadId: database.id,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("wires persisted database and generic readiness deadlines", () =>
    Effect.gen(function* () {
      const configured = yield* compileStack({
        projectRoot: "/tmp/production-runtime-readiness-budget",
        runtime: { kind: "native" },
        config: { capabilities: { database: { settings: { health_timeout: "90s" } } } },
      });
      const defaulted = yield* compileStack({
        projectRoot: "/tmp/production-runtime-readiness-budget-default",
        runtime: { kind: "native" },
      });
      const configuredDatabase = configured.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      const defaultDatabase = defaulted.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      const generic = configured.executionPlan.workloads.find(({ id }) => id === "rest:rest");
      if (
        configuredDatabase === undefined ||
        defaultDatabase === undefined ||
        generic === undefined
      )
        return;
      const configuredState = {
        ...stateFor({}),
        definition: configured.definition,
      };
      const defaultState = {
        ...stateFor({}),
        definition: defaulted.definition,
      };
      expect(
        Duration.toMillis(yield* readinessDeadlineFor(configuredState, configuredDatabase)),
      ).toBe(90_000);
      expect(Duration.toMillis(yield* readinessDeadlineFor(defaultState, defaultDatabase))).toBe(
        120_000,
      );
      expect(Duration.toMillis(yield* readinessDeadlineFor(configuredState, generic))).toBe(30_000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an invalid database readiness budget before creating a workload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* compileStack({
          projectRoot: "/tmp/production-runtime-invalid-health-timeout",
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: { database: { settings: { health_timeout: "not-a-duration" } } },
          },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toBeInstanceOf(InvalidStackConfigError);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("rejects a zero persisted database readiness budget", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: "/tmp/production-runtime-zero-health-timeout",
        runtime: { kind: "native" },
      });
      const database = compiled.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      if (database === undefined) return;
      const state = {
        ...stateFor({}),
        definition: {
          ...compiled.definition,
          capabilities: {
            ...compiled.definition.capabilities,
            database: {
              ...compiled.definition.capabilities.database,
              settings: {
                ...compiled.definition.capabilities.database.settings,
                health_timeout: "0",
              },
            },
          },
        },
      };
      const result = yield* readinessDeadlineFor(state, database).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
          StackPreparationError,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("exposes artifact-only preparation without starting workloads or mutating state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-prepare-" });
        const current = { value: stateFor({}) };
        const preparedCalls: string[] = [];
        const preparer: RuntimeArtifactPreparer = {
          prepare: (_runtime, workload) =>
            Effect.sync(() => {
              preparedCalls.push(workload.id);
              return {
                workloadId: workload.id,
                capability: workload.capability,
                version: "17.6.1.167",
                outcome: workload.id.endsWith("download")
                  ? ("downloaded" as const)
                  : ("cached" as const),
                artifactRoot: "/tmp/prepared",
              };
            }),
        };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: preparer,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        if (runtime.prepare === undefined) return yield* Effect.die("prepare seam missing");
        const before = current.value;
        const result = yield* runtime.prepare({ kind: "native" }, [
          workloadFor("database:database", "database", {
            kind: "native",
            release: "17.6.1.167",
          }),
          workloadFor("rest:download", "rest", {
            kind: "native",
            release: "17.6.1.167",
          }),
        ]);
        expect(result.map(({ workloadId, outcome }) => [workloadId, outcome])).toEqual([
          ["database:database", "cached"],
          ["rest:download", "downloaded"],
        ]);
        expect(preparedCalls).toEqual(["database:database", "rest:download"]);
        expect(current.value).toEqual(before);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not create the Functions root during preflight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-functions-root-",
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const secrets = Object.fromEntries(
          compiled.secrets.map((entry) => [
            entry.slot,
            { policy: entry.policy, value: "test-secret" },
          ]),
        );
        const current = {
          value: {
            ...stateFor(secrets),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: compiled.definition,
            secrets,
          },
        } satisfies { value: PersistedStackState };
        const functionsRoot = compiled.definition.capabilities.functions.settings.functions_root;
        if (functionsRoot === null) return yield* Effect.die("Functions root was not materialized");
        expect(yield* fs.exists(functionsRoot)).toBe(false);
        const prepared: string[] = [];
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.sync(() => {
                prepared.push(workload.id);
                return {
                  workloadId: workload.id,
                  capability: workload.capability,
                  version: "test",
                  outcome: "cached" as const,
                };
              }),
          },
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        yield* runtime.preflight(
          {
            stackId,
            desiredLifecycle: "stopped",
            state: current.value,
            definition: compiled.definition,
            secrets,
            plan: compiled.executionPlan,
          },
          "cold",
        );
        expect(yield* fs.exists(functionsRoot)).toBe(false);
        expect(prepared).toEqual(["database:database"]);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an occupied persisted native port during a cold preflight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-preflight-" });
        const occupied = createNetServer();
        yield* listenForNativeReadiness(occupied);
        const address = occupied.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("occupied listener has no TCP address");
        const port = yield* Schema.decodeEffect(NetworkPortSchema)(address.port).pipe(Effect.orDie);
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const secrets = Object.fromEntries(
          compiled.secrets.map((entry) => [
            entry.slot,
            { policy: entry.policy, value: "test-secret" },
          ]),
        );
        const current = {
          value: {
            ...stateFor(secrets),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: compiled.definition,
            ports: [{ field: "database", port, intent: "exact" }],
            secrets,
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached",
              }),
          },
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const result = yield* runtime
          .preflight(
            {
              stackId,
              desiredLifecycle: "running",
              state: current.value,
              definition: compiled.definition,
              secrets,
              plan: compiled.executionPlan,
            },
            "cold",
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(PortUnavailableError);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects native database lock evidence owned by a live process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-lock-" });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const secrets = Object.fromEntries(
          compiled.secrets.map((entry) => [
            entry.slot,
            { policy: entry.policy, value: "test-secret" },
          ]),
        );
        const current = {
          value: {
            ...stateFor(secrets),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: compiled.definition,
            secrets,
          },
        } satisfies { value: PersistedStackState };
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(path.join(paths.data, "database"), { recursive: true });
        yield* fs.writeFileString(
          path.join(paths.data, "database", "postmaster.pid"),
          `${process.pid}\n`,
        );
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached",
              }),
          },
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const result = yield* runtime
          .preflight(
            {
              stackId,
              desiredLifecycle: "running",
              state: current.value,
              definition: compiled.definition,
              secrets,
              plan: compiled.executionPlan,
            },
            "cold",
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(StackPreparationError);
          expect(error?.message).toContain("live process");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("redacts logs using secret slots materialized after factory creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-logs-" });
        const current = { value: stateFor({}) };
        const reads = { value: 0 };
        const entries: StackLogEntry[] = [];
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const completeSecrets = Object.fromEntries(
          compiled.secrets.map((entry) => [
            entry.slot,
            { policy: entry.policy, value: "placeholder" },
          ]),
        );
        const candidate = {
          ...stateFor({
            ...completeSecrets,
            "secret:auth.settings.jwt_secret": {
              policy: "managed" as const,
              value: "rotated-secret",
            },
          }),
          desiredLifecycle: "running" as const,
          definition: compiled.definition,
        } satisfies PersistedStackState;
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current, () => reads.value++),
          context,
          ingress,
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
              }),
          },
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore(entries),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        yield* runtime.preflight(
          {
            stackId,
            desiredLifecycle: "running",
            state: candidate,
            definition: compiled.definition,
            secrets: candidate.secrets,
            plan: compiled.executionPlan,
          },
          "cold",
        );
        const logStore = runtime.logStore;
        expect(logStore).toBeDefined();
        if (logStore === undefined) return;
        yield* logStore.append({
          source: "auth",
          stream: "stdout",
          message: "token=rotated-secret",
        });
        yield* logStore.append({
          source: "auth",
          stream: "stdout",
          message: "token=rotated-secret again",
        });
        expect(entries[0]?.message).toBe("token=[REDACTED]");
        expect(entries[1]?.message).toBe("token=[REDACTED] again");
        expect(reads.value).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("wires owner material into container workloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-inputs-" });
        const template = path.join(root, "templates", "confirmation.html");
        yield* fs.makeDirectory(path.dirname(template), { recursive: true });
        yield* fs.writeFileString(template, "confirmation");
        const gcpCredentials = path.join(root, "gcp.json");
        yield* fs.writeFileString(gcpCredentials, "{}");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  email: {
                    template: { confirmation: { content_path: "templates/confirmation.html" } },
                  },
                },
              },
              pooler: { enabled: true },
              rest: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: {
                enabled: true,
                settings: {
                  edge_runtime: { secrets: { FACTORY_SECRET: Redacted.make("factory-secret") } },
                },
              },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: {
                enabled: true,
                settings: { backend: "bigquery", gcp_jwt_path: "gcp.json" },
              },
            },
            listeners: {
              database: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        }).pipe(Effect.provide(NodeServices.layer));
        const authServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* listenForNativeReadiness(authServer);
        const authAddress = authServer.address();
        if (typeof authAddress !== "object" || authAddress === null)
          return yield* Effect.die("Auth readiness server did not expose an address");
        const functionsServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* listenForNativeReadiness(functionsServer);
        const functionsAddress = functionsServer.address();
        if (typeof functionsAddress !== "object" || functionsAddress === null)
          return yield* Effect.die("Functions readiness server did not expose an address");
        const analyticsServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* listenForNativeReadiness(analyticsServer);
        const analyticsAddress = analyticsServer.address();
        if (typeof analyticsAddress !== "object" || analyticsAddress === null)
          return yield* Effect.die("Analytics readiness server did not expose an address");
        const poolerServer = createServer((_request, response) => {
          response.statusCode = 204;
          response.end();
        });
        yield* listenForNativeReadiness(poolerServer);
        const poolerAddress = poolerServer.address();
        if (typeof poolerAddress !== "object" || poolerAddress === null)
          return yield* Effect.die("Pooler readiness server did not expose an address");
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
                "secret:auth.settings.publishable_key": {
                  policy: "managed",
                  value: "sb_publishable_test",
                },
                "secret:auth.settings.secret_key": {
                  policy: "managed",
                  value: "sb_secret_test",
                },
                "secret:functions.settings.edge_runtime.secrets.FACTORY_SECRET": {
                  policy: "managed",
                  value: "factory-secret",
                },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            ports: [{ field: "api" as const, port: 40_000, intent: "exact" as const }],
            privatePorts: [
              {
                workloadId: "auth:auth",
                binding: "primary",
                port: authAddress.port,
              },
              {
                workloadId: "pooler:pooler",
                binding: "primary",
                port: poolerAddress.port + 1,
              },
              {
                workloadId: "pooler:pooler",
                binding: "admin",
                port: poolerAddress.port,
              },
              {
                workloadId: "functions:edge-runtime",
                binding: "primary",
                port: functionsAddress.port,
              },
              {
                workloadId: "analytics:analytics",
                binding: "primary",
                port: analyticsAddress.port,
              },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const copiedFiles: Array<Readonly<{ source: string; destination: string }>> = [];
        const engine = ownerInputContainerEngine(createdSpecs, copiedFiles);
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const auth = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "auth:auth",
        );
        const pooler = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "pooler:pooler",
        );
        if (auth === undefined || pooler === undefined)
          return yield* Effect.die("Expected Auth and Pooler workloads");
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: auth.id,
          },
          auth,
        );
        const authSpec = createdSpecs.find((spec) => spec.labels.workloadId === auth.id);
        if (authSpec === undefined || authSpec.envFile === undefined)
          return yield* Effect.die("Auth container was not captured");
        const authEnv = yield* fs.readFileString(authSpec.envFile);
        expect(authEnv).toContain("GOTRUE_JWT_SECRET=jwt-secret");
        expect(authEnv).toContain(
          "GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://host.docker.internal:40000/email/confirmation.html",
        );
        const functions = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "functions:edge-runtime",
        );
        const analytics = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "analytics:analytics",
        );
        if (functions === undefined || analytics === undefined)
          return yield* Effect.die("Expected Functions and Analytics workloads");
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: functions.id,
          },
          functions,
        );
        const functionsSpec = createdSpecs.find((spec) => spec.labels.workloadId === functions.id);
        if (functionsSpec?.envFile === undefined)
          return yield* Effect.die("Functions container was not captured");
        const firstBootstrap = copiedFiles.at(-1);
        if (firstBootstrap === undefined)
          return yield* Effect.die("Functions bootstrap was not captured");
        const firstBootstrapPath = firstBootstrap.source;
        expect(yield* fs.exists(firstBootstrapPath)).toBe(true);
        expect(yield* fs.readFileString(functionsSpec.envFile)).toContain(
          "FACTORY_SECRET=factory-secret",
        );
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: analytics.id,
          },
          analytics,
        );
        const analyticsSpec = createdSpecs.find((spec) => spec.labels.workloadId === analytics.id);
        expect(analyticsSpec?.mounts).toContainEqual({
          source: expect.stringContaining("gcp.json"),
          target: "/opt/app/rel/logflare/bin/gcloud.json",
          readOnly: true,
        });
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: pooler.id,
          },
          pooler,
        );
        const poolerSpec = createdSpecs.find(
          (spec) => spec.labels.workloadId === pooler.id && spec.labels.startup !== true,
        );
        const poolerStartupSpecs = createdSpecs.filter(
          (spec) => spec.labels.workloadId === pooler.id && spec.labels.startup === true,
        );
        expect(poolerSpec?.mounts).toContainEqual({
          source: expect.stringContaining("pooler_tenant.exs"),
          target: "/app/pooler_tenant.exs",
          readOnly: true,
        });
        expect(
          poolerStartupSpecs.some((spec) =>
            spec.command?.join(" ").includes("/app/bin/supavisor eval"),
          ),
        ).toBe(true);
        const tenantPath = poolerSpec?.mounts.find(
          (mount) => mount.target === "/app/pooler_tenant.exs",
        )?.source;
        if (tenantPath === undefined)
          return yield* Effect.die("Pooler tenant mount was not captured");
        expect(yield* fs.exists(tenantPath)).toBe(true);
        yield* runtime.driver.stop({
          stackId,
          workloadId: pooler.id,
        });
        // Runtime inputs are session-owned and remain available across an individual workload
        // restart; the owner cleanup at session end removes the flat path.
        expect(yield* fs.exists(tenantPath)).toBe(true);
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: pooler.id,
          },
          pooler,
        );
        const secondSpec = createdSpecs.findLast((spec) => spec.labels.workloadId === pooler.id);
        const secondTenantPath = secondSpec?.mounts.find(
          (mount) => mount.target === "/app/pooler_tenant.exs",
        )?.source;
        if (secondTenantPath === undefined)
          return yield* Effect.die("Second Pooler tenant mount was not captured");
        expect(yield* fs.exists(secondTenantPath)).toBe(true);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* fs.exists(secondTenantPath)).toBe(false);
        expect(yield* fs.exists(firstBootstrapPath)).toBe(false);
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: functions.id,
          },
          functions,
        );
        const restartedBootstrap = copiedFiles.at(-1);
        if (restartedBootstrap === undefined || restartedBootstrap === firstBootstrap)
          return yield* Effect.die("Restarted Functions bootstrap was not captured");
        expect(yield* fs.exists(restartedBootstrap.source)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("scopes Auth template URL requirements to the Auth workload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-auth-scope-",
        });
        const template = path.join(root, "confirmation.html");
        yield* fs.writeFileString(template, "confirmation");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  email: { template: { confirmation: { content_path: "confirmation.html" } } },
                },
              },
              rest: { enabled: true },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: {
              api: { enabled: false },
              database: { enabled: false },
              pooler: { enabled: false },
              studio: { enabled: false },
              mailUi: { enabled: false },
              smtp: { enabled: false },
              pop3: { enabled: false },
              functionsInspector: { enabled: false },
            },
          },
        }).pipe(Effect.provide(NodeServices.layer));
        const restServer = createServer((_request, response) => {
          response.statusCode = 200;
          response.setHeader("Connection", "close");
          response.end("ok");
        });
        yield* listenForNativeReadiness(restServer);
        const address = restServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("REST readiness server did not expose an address");
        const current = {
          value: {
            ...stateFor(
              {
                "secret:database.internal.password": { policy: "managed", value: "db-secret" },
                "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
              },
              { kind: "container", engine: "docker" },
            ),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            privatePorts: [
              { workloadId: "rest:rest", binding: "primary", port: address.port },
              { workloadId: "rest:rest", binding: "admin", port: address.port + 1 },
              { workloadId: "auth:auth", binding: "primary", port: address.port + 2 },
            ],
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: ownerInputContainerEngine(createdSpecs),
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
                image: workload.selected.kind === "container" ? workload.selected.image : undefined,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        const rest = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "rest:rest",
        );
        const auth = compiled.executionPlan.workloads.find(
          (workload) => workload.id === "auth:auth",
        );
        if (rest === undefined || auth === undefined)
          return yield* Effect.die("Expected REST and Auth workloads");
        yield* runtime.driver.start({ stackId, workloadId: rest.id }, rest);
        expect(createdSpecs.some((spec) => spec.labels.workloadId === rest.id)).toBe(true);
        const authStart = yield* runtime.driver
          .start({ stackId, workloadId: auth.id }, auth)
          .pipe(Effect.exit);
        expect(Exit.isFailure(authStart)).toBe(true);
        expect(createdSpecs.some((spec) => spec.labels.workloadId === auth.id)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("cleans owner env and Functions files only during stack cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-cleanup-" });
        const current = { value: stateFor({}) };
        const envOwner = yield* makeRuntimeEnvFileOwner({ stateRoot: root, stackId });
        const functionsOwner = yield* makeFunctionsBootstrapOwner({
          stateRoot: root,
          stackId,
        });
        const envPath = yield* envOwner.write({
          workloadId: "database:database",
          values: { TOKEN: "stale" },
        });
        const bootstrapPath = yield* functionsOwner.write({
          content: "export default 1",
        });
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const factory = yield* makeProductionRuntimeFactory({
          stateRoot: root,
          stackId,
          ownerSessionId: "owner",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          artifactPreparer: artifacts,
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
        const runtime = yield* factory.make(current.value);
        yield* runtime.driver.stop({
          stackId,
          workloadId: "database:database",
        });
        expect(yield* fs.exists(envPath)).toBe(true);
        expect(yield* fs.exists(bootstrapPath)).toBe(true);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* fs.exists(envPath)).toBe(false);
        expect(yield* fs.exists(bootstrapPath)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it("attempts both owner cleanups when runtime cleanup fails", () => {
    const calls: string[] = [];
    const runtimeFailure = new RuntimeDriverError({
      message: "runtime cleanup failed",
      stackId,
    });
    const driver: RuntimeDriver = {
      observe: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.void,
      remove: () => Effect.void,
      cleanup: () => Effect.fail(runtimeFailure),
    };
    const envOwner: RuntimeEnvFileOwner = {
      write: () => Effect.die("unused"),
      cleanupAll: Effect.sync(() => {
        calls.push("env");
      }),
    };
    const functionsOwner: FunctionsBootstrapOwner = {
      write: () => Effect.die("unused"),
      cleanupAll: Effect.sync(() => {
        calls.push("functions");
      }),
    };
    const wrapped = withOwnedRuntimeFileCleanup(driver, envOwner, functionsOwner);
    const result = Effect.runSyncExit(wrapped.cleanup({ stackId, destroy: false }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(calls.sort()).toEqual(["env", "functions"]);
  });

  it("continues owner cleanup when one file owner fails", () => {
    const calls: string[] = [];
    const driver: RuntimeDriver = {
      observe: () => Effect.succeed([]),
      start: () => Effect.die("unused"),
      stop: () => Effect.void,
      remove: () => Effect.void,
      cleanup: () => Effect.void,
    };
    const envOwner: RuntimeEnvFileOwner = {
      write: () => Effect.die("unused"),
      cleanupAll: Effect.gen(function* () {
        calls.push("env");
        return yield* new StackPreparationError({ message: "env cleanup failed" });
      }),
    };
    const functionsOwner: FunctionsBootstrapOwner = {
      write: () => Effect.die("unused"),
      cleanupAll: Effect.sync(() => {
        calls.push("functions");
      }),
    };
    const wrapped = withOwnedRuntimeFileCleanup(driver, envOwner, functionsOwner);
    const result = Effect.runSyncExit(wrapped.cleanup({ stackId, destroy: false }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(calls).toEqual(["env", "functions"]);
  });
});
