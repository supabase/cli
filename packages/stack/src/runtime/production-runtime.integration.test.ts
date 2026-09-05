// oxlint-disable effecttsgo/prefer-schema-over-json -- generated shell fixtures use protocol JSON quoting, not product serialization.
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
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
import type { CapabilityName } from "../public/Capability.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import { NetworkPortSchema } from "../public/Status.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { LogStoreError } from "../supervisor/LogStore.ts";
import type { LifecycleInput } from "../supervisor/Lifecycle.ts";
import {
  makeProductionRuntime,
  readinessDeadlineFor,
  withOwnedRuntimeFileCleanup,
} from "./ProductionRuntime.ts";
import { makeSupervisor } from "../supervisor/Supervisor.ts";
import { RuntimeDriverError, type RuntimeDriver } from "./RuntimeDriver.ts";
import {
  InvalidStackConfigError,
  PortUnavailableError,
  StackPreparationError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import { makeRuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import { makeArtifactStore, type ArtifactSource } from "../preparation/ArtifactStore.ts";
import { compileStack } from "../model/Compiler.ts";
import type {
  ContainerContainerSpec,
  ContainerEngine,
  ContainerResource,
  ContainerNetworkSpec,
  ContainerVolumeSpec,
} from "./ContainerEngine.ts";
import { ContainerEngineProtocolError } from "./ContainerEngine.ts";
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
  recoverRuntimeRemnant: () => Effect.die("unused"),
});

const mutableStateStoreFor = (current: {
  value: PersistedStackState | undefined;
}): StackStateStore => ({
  read: () => Effect.succeed(current.value),
  initialize: () => Effect.die("unused"),
  replace: (_stackId, state) =>
    Effect.sync(() => {
      current.value = state;
    }),
  replaceUnlocked: (_stackId, state) =>
    Effect.sync(() => {
      current.value = state;
    }),
  cleanup: () =>
    Effect.sync(() => {
      current.value = undefined;
    }),
  recoverRuntimeRemnant: () => Effect.void,
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
) =>
  Effect.gen(function* () {
    const binDirectory = path.join(root, "bin");
    yield* fs.makeDirectory(binDirectory, { recursive: true });
    const main = path.join(binDirectory, "supabase-postgres-start");
    const helperScript = [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      "const args = process.argv.slice(1);",
      'const port = Number(args[args.indexOf("-p") + 1]);',
      `fs.appendFileSync(${JSON.stringify(eventsPath)}, "postgres-start|data=" + process.env.PGDATA + "|user=" + process.env.POSTGRES_USER + "|db=" + process.env.POSTGRES_DB + "|password=" + process.env.POSTGRES_PASSWORD + "|args=" + args.join(" ") + "\\n");`,
      "const server = net.createServer((socket) => socket.end());",
      'server.listen(port, "127.0.0.1");',
      "const stop = () => server.close(() => process.exit(0));",
      'process.on("SIGTERM", stop);',
      'process.on("SIGINT", stop);',
    ].join("");
    yield* fs.writeFileString(
      main,
      `#!/bin/sh
set -eu
exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(helperScript)} -- "$@"
`,
    );
    yield* fs.chmod(main, 0o755);
    return { main };
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
    const prepare = path.join(bin, "prepare");
    yield* fs.writeFileString(
      prepare,
      `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
"$SCRIPT_DIR/migrate"
if [ "\${SEED_SELF_HOST:-}" = true ]; then
  "$SCRIPT_DIR/realtime" eval 'Realtime.Release.seeds(Realtime.Repo)'
fi
`,
    );
    yield* fs.chmod(prepare, 0o755);
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

describe("production runtime", () => {
  it.live("validates materialized secrets from the candidate definition and values", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-candidate-",
        });
        const previous = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const previousSecrets = yield* resolveSecrets(
          { declarations: previous.secrets },
          undefined,
          "stopped",
        );
        const candidate = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              storage: {
                enabled: true,
                settings: {
                  s3_protocol: {
                    secret_access_key: Redacted.make("candidate-secret"),
                  },
                },
              },
            },
          },
        });
        const candidateSecrets = yield* resolveSecrets(
          { declarations: candidate.secrets },
          undefined,
          "stopped",
        );
        const missing = Object.fromEntries(
          Object.entries(candidateSecrets.persisted).filter(
            ([slot]) => slot !== "secret:storage.settings.s3_protocol.secret_access_key",
          ),
        );
        const current = {
          value: {
            ...stateFor({}, { kind: "native" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: previous.definition,
            secrets: previousSecrets.persisted,
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "candidate-secrets",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          artifactPreparer: {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: "cached" as const,
              }),
          },
          logStore: memoryLogStore([]),
        });
        const result = yield* runtime
          .preflight({
            stackId,
            state: current.value,
            definition: candidate.definition,
            secrets: missing,
            plan: candidate.executionPlan,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(StackStateInvalidError);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps cleanup available when retained logs are corrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-bad-logs-" });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
        });
        const paths = yield* resolveStackPaths({ stateRoot: root, stackId });
        yield* fs.makeDirectory(path.dirname(paths.logs), { recursive: true });
        yield* fs.writeFileString(paths.logs, "not-json\n");
        const current = {
          value: {
            ...stateFor({}, { kind: "container", engine: "docker" }),
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
          },
        } satisfies { value: PersistedStackState | undefined };
        const store = mutableStateStoreFor(current);
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "bad-logs-owner",
          stateStore: store,
          context,
          ingress,
          artifactPreparer: artifacts,
          containerEngine: ownerInputContainerEngine([]),
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
        });
        const supervisor = yield* makeSupervisor({
          stackId,
          ownerSessionId: "bad-logs-owner",
          stateStore: store,
          context,
          runtime,
        });
        const failed = yield* supervisor.start().pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) {
          const error = Cause.findErrorOption(failed.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackPreparationError);
            expect(error.value.cause).toBeInstanceOf(LogStoreError);
          }
        }
        const logs = yield* supervisor.logs().pipe(Effect.exit);
        expect(Exit.isFailure(logs)).toBe(true);
        if (Exit.isFailure(logs)) {
          const error = Cause.findErrorOption(logs.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackStateInvalidError);
            expect(error.value.cause).toBeInstanceOf(LogStoreError);
          }
        }
        expect(yield* fs.readFileString(paths.logs)).toBe("not-json\n");
        expect((yield* supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect(yield* fs.readFileString(paths.logs)).toBe("not-json\n");
        yield* supervisor.destroy;
        expect(current.value).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

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
        const runtime = yield* makeProductionRuntime({
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

  it.live("defers unreachable Auth OIDC resolution until Auth activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-oidc-lazy-",
        });
        const readinessServer = createNetServer((socket) => socket.end());
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Database readiness server did not expose an address");
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              auth: {
                enabled: true,
                settings: {
                  third_party: {
                    workos: { enabled: true, issuer_url: "https://issuer.example" },
                  },
                },
              },
            },
          },
        });
        const resolved = yield* resolveSecrets(
          { declarations: compiled.secrets },
          undefined,
          "stopped",
        );
        const current = {
          value: {
            ...stateFor(resolved.persisted, { kind: "container", engine: "docker" }),
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
          ({ id }) => id === "database:database",
        );
        const auth = compiled.executionPlan.workloads.find(({ id }) => id === "auth:auth");
        if (database === undefined || auth === undefined)
          return yield* Effect.die("Expected database and Auth workloads");
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "oidc-lazy",
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
          fetchJson: () => Effect.fail(new StackPreparationError({ message: "OIDC unavailable" })),
          bootstrapDatabase: () => Effect.void,
        });
        const databaseReady = yield* runtime.driver.start(
          { stackId, workloadId: database.id },
          database,
        );
        expect(databaseReady.state).toBe("ready");
        const authResult = yield* runtime.driver
          .start({ stackId, workloadId: auth.id }, auth)
          .pipe(Effect.exit);
        expect(Exit.isFailure(authResult)).toBe(true);
        if (Exit.isFailure(authResult)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(authResult.cause));
          expect(error).toBeInstanceOf(RuntimeDriverError);
          expect(error?.message).toContain("OIDC discovery request failed");
          expect(error?.cause).toBeInstanceOf(StackPreparationError);
        }
        yield* runtime.driver.stop({ stackId, workloadId: database.id });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("shares background preparation with a concurrent studio activation closure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-shared-preparation-",
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            preparation: "background",
            capabilities: {
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              mail: { enabled: false },
              pooler: { enabled: false },
              rest: { activation: "eager" },
              analytics: { activation: "eager" },
            },
          },
        });
        const studioWorkloads = compiled.executionPlan.workloads.filter(
          (workload) => workload.capability === "studio",
        );
        const studioImages = new Set(
          studioWorkloads.map((workload) =>
            workload.selected.kind === "container" ? workload.selected.image : "",
          ),
        );
        if (studioImages.has("") || studioImages.size === 0)
          return yield* Effect.die("Expected container Studio workloads");
        const closure: ReadonlySet<CapabilityName> = new Set([
          "database",
          "rest",
          "analytics",
          "studio",
        ]);
        const closureWorkloads = compiled.executionPlan.workloads.filter(
          (workload) =>
            closure.has(workload.capability) &&
            !studioImages.has(
              workload.selected.kind === "container" ? workload.selected.image : "",
            ),
        );
        if (closureWorkloads.length < 2)
          return yield* Effect.die("Expected at least two non-Studio closure workloads");
        const blocked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const releaseClosure = yield* Deferred.make<void>();
        const newClosureWorkStarted = yield* Deferred.make<void>();
        let blockedPullsStarted = 0;
        let closurePullsStarted = 0;
        const pulls = new Map<string, number>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const baseEngine = ownerInputContainerEngine(createdSpecs);
        const engine: ContainerEngine = {
          ...baseEngine,
          inspectImage: () => Effect.succeed({ present: false }),
          pullImage: (image) =>
            Effect.gen(function* () {
              pulls.set(image, (pulls.get(image) ?? 0) + 1);
              if (studioImages.has(image)) {
                blockedPullsStarted += 1;
                if (blockedPullsStarted === studioImages.size)
                  yield* Deferred.succeed(blocked, undefined);
                yield* Deferred.await(release);
              } else {
                closurePullsStarted += 1;
                if (closurePullsStarted === closureWorkloads.length)
                  yield* Deferred.succeed(newClosureWorkStarted, undefined);
                yield* Deferred.await(releaseClosure);
              }
            }),
        };
        const current = {
          value: {
            ...stateFor({}, { kind: "container", engine: "docker" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "shared-preparation",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: makeRuntimeArtifactPreparer({ containerEngine: engine }),
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
        });
        const input: LifecycleInput = {
          stackId,
          state: current.value,
          definition: compiled.definition,
          secrets: current.value.secrets,
          plan: compiled.executionPlan,
        };
        const background = yield* Effect.forkChild(runtime.prefetch(current.value), {
          startImmediately: true,
        });
        yield* Deferred.await(blocked);
        expect(yield* runtime.artifacts).toEqual(
          expect.arrayContaining(
            studioWorkloads.map((workload) =>
              expect.objectContaining({
                workloadId: workload.id,
                state: "downloading",
              }),
            ),
          ),
        );
        const foreground = yield* Effect.forkChild(runtime.prepare(input, closure), {
          startImmediately: true,
        });
        const interruptedWaiter = yield* Effect.forkChild(runtime.prepare(input, closure), {
          startImmediately: true,
        });
        yield* Deferred.await(newClosureWorkStarted);
        const interrupted = yield* Fiber.interrupt(interruptedWaiter).pipe(Effect.exit);
        expect(Exit.isSuccess(interrupted)).toBe(true);
        const waiterExit = yield* Fiber.join(interruptedWaiter).pipe(Effect.exit);
        expect(Exit.isFailure(waiterExit)).toBe(true);
        expect(yield* Deferred.isDone(blocked)).toBe(true);
        expect(closurePullsStarted).toBe(closureWorkloads.length);
        yield* Deferred.succeed(releaseClosure, undefined);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(background);
        yield* Fiber.join(foreground);
        for (const workload of compiled.executionPlan.workloads.filter((entry) =>
          closure.has(entry.capability),
        )) {
          if (workload.selected.kind === "container")
            expect(pulls.get(workload.selected.image)).toBe(1);
        }
        expect(createdSpecs).toHaveLength(0);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* runtime.artifacts).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps background preparation best effort and retries a failed artifact on activation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-production-preparation-retry-",
          });
          const compiled = yield* compileStack({
            projectRoot: root,
            runtime: { kind: "container", engine: "docker" },
            config: {
              preparation: "background",
              capabilities: {
                auth: { enabled: false },
                realtime: { enabled: false },
                storage: { enabled: false },
                functions: { enabled: false },
                studio: { enabled: false },
                mail: { enabled: false },
                pooler: { enabled: false },
              },
            },
          });
          const rest = compiled.executionPlan.workloads.find(
            (workload) => workload.capability === "rest",
          );
          const analytics = compiled.executionPlan.workloads.find(
            (workload) => workload.capability === "analytics",
          );
          if (
            rest === undefined ||
            analytics === undefined ||
            rest.selected.kind !== "container" ||
            analytics.selected.kind !== "container"
          )
            return yield* Effect.die("Expected REST and analytics container workloads");
          const restImage = rest.selected.image;
          const pullAttempts = new Map<string, number>();
          const logs: StackLogEntry[] = [];
          const createdSpecs: ContainerContainerSpec[] = [];
          const baseEngine = ownerInputContainerEngine(createdSpecs);
          const engine: ContainerEngine = {
            ...baseEngine,
            inspectImage: () => Effect.succeed({ present: false }),
            pullImage: (image) =>
              Effect.gen(function* () {
                const attempt = pullAttempts.get(image) ?? 0;
                pullAttempts.set(image, attempt + 1);
                if (image === restImage && attempt === 0)
                  return yield* new ContainerEngineProtocolError({
                    operation: "pull-image",
                    message: "temporary image registry failure",
                  });
              }),
          };
          const current = {
            value: {
              ...stateFor({}, { kind: "container", engine: "docker" }),
              identity: {
                ...stateFor({}).identity,
                projectRoot: root,
                checkoutRoot: root,
                workspaceId: root,
                checkoutId: root,
              },
              desiredLifecycle: "running" as const,
              definition: compiled.definition,
            },
          } satisfies { value: PersistedStackState };
          const context = yield* Effect.context<
            FileSystem.FileSystem | Path.Path | Crypto.Crypto
          >();
          const runtime = yield* makeProductionRuntime({
            stateRoot: root,
            stackId,
            ownerSessionId: "preparation-retry",
            stateStore: stateStoreFor(current),
            context,
            ingress,
            containerEngine: engine,
            artifactPreparer: makeRuntimeArtifactPreparer({ containerEngine: engine }),
            envFileOwner: envFiles,
            functionsBootstrapOwner: bootstrap,
            logStore: memoryLogStore(logs),
          });
          const background = yield* runtime.prefetch(current.value);
          expect(background).toBeUndefined();
          expect(pullAttempts.get(restImage)).toBe(1);
          expect(pullAttempts.get(analytics.selected.image)).toBe(1);
          const statusesAfterBackground = yield* runtime.artifacts;
          expect(statusesAfterBackground).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                workloadId: rest.id,
                state: "failed",
                error: expect.stringContaining("Unable to pull container image"),
              }),
              expect.objectContaining({ workloadId: analytics.id, state: "ready" }),
            ]),
          );
          expect(
            logs.some((entry) =>
              entry.message.includes(`Background preparation failed for ${rest.id}`),
            ),
          ).toBe(true);
          const input: LifecycleInput = {
            stackId,
            state: current.value,
            definition: compiled.definition,
            secrets: current.value.secrets,
            plan: compiled.executionPlan,
          };
          yield* runtime.prepare(input, new Set(["rest"]));
          expect(pullAttempts.get(restImage)).toBe(2);
          expect(
            (yield* runtime.artifacts).find(({ workloadId }) => workloadId === rest.id),
          ).toEqual(expect.objectContaining({ workloadId: rest.id, state: "ready" }));
          expect(createdSpecs).toHaveLength(0);
          yield* runtime.driver.cleanup({ stackId, destroy: false });
          expect(yield* runtime.artifacts).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports eager artifact progress while preflight is waiting for a pull", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-eager-preparation-",
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            preparation: "on-demand",
            capabilities: {
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const database = compiled.executionPlan.workloads.find(
          (workload) => workload.capability === "database",
        );
        if (database === undefined || database.selected.kind !== "container")
          return yield* Effect.die("Expected container database workload");
        const databaseImage = database.selected.image;
        const resolved = yield* resolveSecrets(
          { declarations: compiled.secrets },
          undefined,
          "stopped",
        );
        const current = {
          value: {
            ...stateFor(resolved.persisted, { kind: "container", engine: "docker" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            definition: compiled.definition,
            secrets: resolved.persisted,
          },
        } satisfies { value: PersistedStackState };
        const pullStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const createdSpecs: ContainerContainerSpec[] = [];
        let pullCount = 0;
        const baseEngine = ownerInputContainerEngine(createdSpecs);
        const engine: ContainerEngine = {
          ...baseEngine,
          inspectImage: () => Effect.succeed({ present: false }),
          pullImage: (image) =>
            image === databaseImage
              ? Effect.gen(function* () {
                  pullCount += 1;
                  yield* Deferred.succeed(pullStarted, undefined);
                  yield* Deferred.await(release);
                })
              : Effect.void,
        };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "eager-preparation",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: makeRuntimeArtifactPreparer({ containerEngine: engine }),
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          logStore: memoryLogStore([]),
        });
        const input: LifecycleInput = {
          stackId,
          state: current.value,
          definition: compiled.definition,
          secrets: resolved.persisted,
          plan: compiled.executionPlan,
        };
        const preflight = yield* Effect.forkChild(runtime.preflight(input), {
          startImmediately: true,
        });
        yield* Deferred.await(pullStarted);
        expect(yield* runtime.artifacts).toEqual([
          expect.objectContaining({ workloadId: database.id, state: "downloading" }),
        ]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(preflight);
        expect(yield* runtime.artifacts).toEqual([
          expect.objectContaining({ workloadId: database.id, state: "ready" }),
        ]);
        expect(createdSpecs).toHaveLength(0);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* runtime.artifacts).toEqual([]);
        yield* runtime.prefetch(current.value);
        expect(pullCount).toBe(1);
        expect(yield* runtime.artifacts).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels an in-flight native artifact transfer during runtime cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-native-artifact-stop-",
        });
        const transferStarted = yield* Deferred.make<void>();
        const transferInterrupted = yield* Deferred.make<void>();
        const archiveSha256 = "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a";
        const checksumFailure = new StackPreparationError({
          message: "published checksum lookup is temporarily unavailable",
        });
        let checksumCalls = 0;
        const source: ArtifactSource = {
          checksum: () =>
            Effect.sync(() => {
              checksumCalls += 1;
              return checksumCalls;
            }).pipe(
              Effect.flatMap((calls) =>
                calls === 1 ? Effect.fail(checksumFailure) : Effect.succeed(archiveSha256),
              ),
            ),
          materialize: (_request, destination, _expectedSha256, onProgress) =>
            Effect.gen(function* () {
              const sourceFile = path.join(destination, "partial-source");
              onProgress?.("downloading");
              yield* fs.writeFileString(sourceFile, "partial");
              yield* Deferred.succeed(transferStarted, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.ensuring(Deferred.succeed(transferInterrupted, undefined)),
              Effect.mapError(
                (cause) => new StackPreparationError({ message: "native transfer failed", cause }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: path.join(root, "artifacts"), source });
        const preparer = makeRuntimeArtifactPreparer({
          native: {
            store,
            platform: { os: "darwin", arch: "arm64" },
          },
        });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
        });
        const current = {
          value: {
            ...stateFor({}, { kind: "native" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
          },
        } satisfies { value: PersistedStackState };
        const workload = compiled.executionPlan.workloads.find(
          (entry) => entry.capability === "database",
        );
        if (workload === undefined) return yield* Effect.die("Expected database workload");
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "native-artifact-stop",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          artifactPreparer: preparer,
          logStore: memoryLogStore([]),
        });
        const input: LifecycleInput = {
          stackId,
          state: current.value,
          definition: compiled.definition,
          secrets: current.value.secrets,
          plan: compiled.executionPlan,
        };
        const firstAttempt = yield* runtime
          .prepare(input, new Set([workload.capability]))
          .pipe(Effect.exit);
        expect(Exit.isFailure(firstAttempt)).toBe(true);
        if (Exit.isFailure(firstAttempt)) {
          const error = Cause.findErrorOption(firstAttempt.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackPreparationError);
            expect(error.value.message).toBe(checksumFailure.message);
          }
        }
        expect(yield* runtime.artifacts).toEqual([
          expect.objectContaining({
            workloadId: workload.id,
            state: "failed",
            error: checksumFailure.message,
          }),
        ]);
        const preparing = yield* Effect.forkChild(
          runtime.prepare(input, new Set([workload.capability])),
          { startImmediately: true },
        );
        yield* Deferred.await(transferStarted);
        expect(yield* runtime.artifacts).toEqual([
          expect.objectContaining({ workloadId: workload.id, state: "downloading" }),
        ]);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* Deferred.isDone(transferInterrupted)).toBe(true);
        const result = yield* Fiber.join(preparing).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const entries = yield* fs.readDirectory(root, { recursive: true });
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(yield* runtime.artifacts).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels an in-flight container image pull during runtime cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-container-pull-stop-",
        });
        const pullStarted = yield* Deferred.make<void>();
        const pullInterrupted = yield* Deferred.make<void>();
        const createdSpecs: ContainerContainerSpec[] = [];
        const baseEngine = ownerInputContainerEngine(createdSpecs);
        const engine: ContainerEngine = {
          ...baseEngine,
          inspectImage: () => Effect.succeed({ present: false }),
          pullImage: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(pullStarted, undefined);
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Deferred.succeed(pullInterrupted, undefined))),
        };
        const preparer = makeRuntimeArtifactPreparer({ containerEngine: engine });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
        });
        const current = {
          value: {
            ...stateFor({}, { kind: "container", engine: "docker" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
          },
        } satisfies { value: PersistedStackState };
        const workload = compiled.executionPlan.workloads.find(
          (entry) => entry.capability === "database",
        );
        if (workload === undefined) return yield* Effect.die("Expected database workload");
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "container-pull-stop",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          containerEngine: engine,
          artifactPreparer: preparer,
          logStore: memoryLogStore([]),
        });
        const input: LifecycleInput = {
          stackId,
          state: current.value,
          definition: compiled.definition,
          secrets: current.value.secrets,
          plan: compiled.executionPlan,
        };
        const preparing = yield* Effect.forkChild(
          runtime.prepare(input, new Set([workload.capability])),
          { startImmediately: true },
        );
        yield* Deferred.await(pullStarted);
        expect(yield* runtime.artifacts).toEqual([
          expect.objectContaining({ workloadId: workload.id, state: "downloading" }),
        ]);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        expect(yield* Deferred.isDone(pullInterrupted)).toBe(true);
        const result = yield* Fiber.join(preparing).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(createdSpecs).toHaveLength(0);
        expect(yield* runtime.artifacts).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("interrupts native input materialization before cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-production-oidc-stop-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              auth: {
                enabled: true,
                settings: {
                  third_party: {
                    workos: { enabled: true, issuer_url: "https://issuer.example" },
                  },
                },
              },
            },
          },
        });
        const resolved = yield* resolveSecrets(
          { declarations: compiled.secrets },
          undefined,
          "stopped",
        );
        const current = {
          value: {
            ...stateFor(resolved.persisted, { kind: "native" }),
            identity: {
              ...stateFor({}).identity,
              projectRoot: root,
              checkoutRoot: root,
              workspaceId: root,
              checkoutId: root,
            },
            desiredLifecycle: "running" as const,
            definition: compiled.definition,
          },
        } satisfies { value: PersistedStackState };
        const auth = compiled.executionPlan.workloads.find(({ id }) => id === "auth:auth");
        if (auth === undefined) return yield* Effect.die("Expected Auth workload");
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
          stateRoot: root,
          stackId,
          ownerSessionId: "oidc-stop",
          stateStore: stateStoreFor(current),
          context,
          ingress,
          envFileOwner: envFiles,
          functionsBootstrapOwner: bootstrap,
          artifactPreparer: artifacts,
          logStore: memoryLogStore([]),
          fetchJson: (url) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
        });
        const key = { stackId, workloadId: auth.id };
        const starting = yield* Effect.forkChild(runtime.driver.start(key, auth), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        yield* runtime.driver.stop(key);
        expect(yield* Deferred.isDone(interrupted)).toBe(true);
        // The release is only a guard for the interrupted implementation under test. A correct
        // owner propagates cancellation from NativeRuntime.startFiber without this handoff.
        yield* Deferred.succeed(release, undefined);
        yield* runtime.driver.cleanup({ stackId, destroy: false });
        const startExit = yield* Fiber.join(starting).pipe(Effect.exit);
        expect(Exit.isFailure(startExit)).toBe(true);
        expect(yield* runtime.driver.observe(stackId)).toEqual([]);
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
        const runtime = yield* makeProductionRuntime({
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
        const runtime = yield* makeProductionRuntime({
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
        const input = {
          stackId,
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
        const runtime = yield* makeProductionRuntime({
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
                version: compiled.definition.capabilities.realtime.version,
                outcome: "cached" as const,
                artifactRoot,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: () => Effect.void,
        });
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

  it.live("starts the canonical PostgreSQL helper before bootstrap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-production-pg-first-" });
        const eventsPath = path.join(root, "events");
        const artifactRoot = path.join(root, "artifact");
        yield* fs.writeFileString(eventsPath, "");
        yield* writeNativeDatabaseFixture(fs, path, artifactRoot, eventsPath);
        const readinessServer = createNetServer();
        yield* listenForNativeReadiness(readinessServer);
        const address = readinessServer.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("Native readiness server did not expose an address");
        yield* Effect.callback<void, Error>((resume) => {
          readinessServer.close((error) =>
            error === undefined ? resume(Effect.void) : resume(Effect.fail(error)),
          );
        });
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
        const runtime = yield* makeProductionRuntime({
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
                version: compiled.definition.capabilities.database.version,
                outcome: "cached" as const,
                artifactRoot,
              }),
          },
          logStore: memoryLogStore([]),
          bootstrapDatabase: bootstrap,
        });
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
        const events = yield* fs.readFileString(eventsPath);
        expect(events).toContain(`postgres-start|data=${databaseDataPath}`);
        expect(events).toContain("user=supabase_admin");
        expect(events).toContain("db=postgres");
        expect(events).toContain("password=db-secret");
        expect(events).toContain(`args=-p ${address.port}`);
        expect(events.indexOf("postgres-start")).toBeLessThan(events.indexOf("bootstrap"));
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
        const runtime = yield* makeProductionRuntime({
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
        yield* runtime.preflight({
          stackId,
          state: current.value,
          definition: compiled.definition,
          secrets,
          plan: compiled.executionPlan,
        });
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
            ports: [{ field: "database", port, intent: "automatic" }],
            secrets,
          },
        } satisfies { value: PersistedStackState };
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const runtime = yield* makeProductionRuntime({
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
        const result = yield* runtime
          .preflight({
            stackId,
            state: current.value,
            definition: compiled.definition,
            secrets,
            plan: compiled.executionPlan,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(PortUnavailableError);
        }
        const changedPort = port === 65_535 ? 65_534 : port + 1;
        const candidates = [
          {
            ...compiled.definition,
            listeners: {
              ...compiled.definition.listeners,
              database: { ...compiled.definition.listeners.database, enabled: false },
            },
          },
          {
            ...compiled.definition,
            listeners: {
              ...compiled.definition.listeners,
              database: { ...compiled.definition.listeners.database, port: changedPort },
            },
          },
        ];
        for (const definition of candidates) {
          const accepted = yield* runtime
            .preflight({
              stackId,
              state: current.value,
              definition,
              secrets,
              plan: compiled.executionPlan,
            })
            .pipe(Effect.exit);
          expect(Exit.isSuccess(accepted)).toBe(true);
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
        const runtime = yield* makeProductionRuntime({
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
        const result = yield* runtime
          .preflight({
            stackId,
            state: current.value,
            definition: compiled.definition,
            secrets,
            plan: compiled.executionPlan,
          })
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
        const runtime = yield* makeProductionRuntime({
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
        yield* runtime.preflight({
          stackId,
          state: candidate,
          definition: compiled.definition,
          secrets: candidate.secrets,
          plan: compiled.executionPlan,
        });
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
        const runtime = yield* makeProductionRuntime({
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
        expect(poolerSpec?.mounts).toEqual([]);
        expect(poolerStartupSpecs.map((spec) => spec.entrypoint)).toEqual([
          "/app/bin/prepare",
          "/app/bin/provision-tenant",
        ]);
        yield* runtime.driver.stop({
          stackId,
          workloadId: pooler.id,
        });
        yield* runtime.driver.start(
          {
            stackId,
            workloadId: pooler.id,
          },
          pooler,
        );
        yield* runtime.driver.cleanup({ stackId, destroy: false });
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
        const runtime = yield* makeProductionRuntime({
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
        const runtime = yield* makeProductionRuntime({
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
