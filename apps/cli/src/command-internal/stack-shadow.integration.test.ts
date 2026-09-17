import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Redacted,
  Stream,
} from "effect";
import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Schema } from "effect";
import { StackRuntimeError, UncertainOperationError } from "@supabase/stack/effect";
import type {
  AnyEffectCreateServiceOptions,
  EffectCreateServiceOptions,
  EffectDatabaseInitialization,
  EffectServiceInstance,
  EffectServiceCollection,
  EffectStack,
  ServiceKind,
  ServiceCredentials,
  ServiceDescriptor,
  SnapshotDescriptor,
  StackStatus,
} from "@supabase/stack/effect";
import { ServiceInstanceIdSchema, StackIdSchema } from "@supabase/stack/effect";
import type { ServiceStatus } from "@supabase/stack/effect";
import { StackApi } from "./stack-api.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { useTempWorkdir, withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { SHADOW_CACHE_ENV } from "./db-bootstrap/shadow-cache.ts";
import {
  stackAcquireShadowDatabase,
  stackReleaseShadowDatabase,
  stackWithShadowDatabase,
} from "./stack-shadow.ts";
import type { ShadowSetupInput } from "./db-bootstrap/shadow-database.ts";
import { recordingStackCatalogSetup } from "./stack-catalog-setup.ts";

const tmp = useTempWorkdir("stack-shadow-");
type StackServiceError = Effect.Error<ReturnType<EffectServiceCollection["create"]>>;
const defaultConfig: CliConfig = Schema.decodeSync(CliConfigSchema)({});
const nativeRuntime = { kind: "native" as const };

const input = (fs: FileSystem.FileSystem, path: Path.Path): ShadowSetupInput<never> => ({
  db: { major_version: 17, settings: {} },
  experimental: defaultConfig.experimental,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  jwtExpiry: 3600,
  networkId: "n",
  image: "stack",
  configImage: "stack",
  shadowPort: 54320,
  password: "postgres",
  projectId: "proj",
  isBitbucketPipeline: false,
  workdir: tmp.current,
  extraHosts: [],
  fs,
  path,
  hostname: "127.0.0.1",
  healthTimeoutSeconds: 2,
  setup: {
    majorVersion: 17,
    config: defaultConfig,
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54320/postgres",
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwks: Effect.succeed("{}"),
    apiUrl: "http://127.0.0.1:54321",
    authExternalUrl: undefined,
    siteUrl: "http://127.0.0.1:3000",
    anonKey: "anon",
    serviceRoleKey: "service",
    storageTargetMigration: "",
    realtimeEnabledForSetup: false,
    storageEnabledForSetup: false,
    authEnabledForSetup: false,
    serviceVersionOverrides: {},
    projectEnvValues: undefined,
    debug: false,
    webhooksEnabled: false,
    apiAutoExposeNewTables: Option.none(),
    vault: [],
  },
});

const serviceId = (id: string) => Schema.decodeSync(ServiceInstanceIdSchema)(id);
const stackId = Schema.decodeSync(StackIdSchema)("a".repeat(64));

const serviceStatus = (
  id: ReturnType<typeof serviceId>,
  name: string,
  phase: ServiceStatus["phase"] = "stopped",
): ServiceStatus => ({
  id,
  service: "database",
  name,
  enabled: true,
  intent: phase === "stopped" ? "stopped" : "started",
  phase,
  activation: "eager",
  endpoints: [],
});

const descriptor = (
  id: string,
  name = `shadow-${id}`,
  profile = "profile:shadow",
  initializationProfile = profile,
): ServiceDescriptor<"database"> => ({
  id: serviceId(id),
  service: "database",
  name,
  enabled: true,
  config: {
    enabled: true,
    activation: "eager",
    idleTimeoutSeconds: false,
    version: "17.6.1",
    settings: {},
  },
  dependencies: {},
  snapshotSupport: "supported",
  endpoints: { sql: { enabled: true, address: "127.0.0.1", port: 55432 } },
  artifactIdentity: "native:17.6.1",
  runtimeIdentity: "native:database:17.6.1",
  bootstrapRecipeId: "database-bootstrap-v1",
  bootstrapInputsId: "inputs:shadow",
  creationInputsId: "creation:shadow",
  effectiveConfigFingerprint: "config:shadow",
  initializationProfileId: profile,
  initialization: {
    profileId: initializationProfile,
    recipes: [
      {
        service: "analytics",
        recipeId: "analytics",
        artifactIdentity: "analytics",
        completed: false,
      },
      { service: "pooler", recipeId: "pooler", artifactIdentity: "pooler", completed: false },
    ],
  },
  data: { origin: "absent" },
});

const snapshotDescriptor = (id: ReturnType<typeof serviceId>): SnapshotDescriptor => ({
  lineageId: "lineage:shadow",
  initializationProfileId: "profile:shadow",
  artifactIdentity: "native:17.6.1",
  runtimeIdentity: "native:database:17.6.1",
  dataFormat: { provider: "postgres", format: "pgdata", majorVersion: 17 },
  provenance: { sourceInstanceId: id, exportOperationId: "export" },
});

const fakeStack = (events: {
  readonly creates: string[];
  readonly initializations?: EffectDatabaseInitialization[];
  readonly restores: string[];
  readonly destroys?: string[];
  readonly pendingSnapshot?: boolean;
  readonly uncertainCreate?: boolean;
  readonly mismatchedCandidate?: boolean;
  readonly profileMismatch?: boolean;
  readonly blockStart?: boolean;
  readonly startEntered?: Deferred.Deferred<void, never>;
  starts?: number;
  restoreFailures?: number;
}) => {
  let serviceNumber = 0;
  let uncertainCandidate: EffectServiceInstance<"database"> | undefined;
  const makeService = (name: string): EffectServiceInstance<"database"> => {
    const id = `service-${String(++serviceNumber)}`;
    const serviceDescriptor = descriptor(
      id,
      name,
      "profile:shadow",
      events.profileMismatch ? "profile:other" : "profile:shadow",
    );
    const credentials: ServiceCredentials<"database"> = {
      url: `postgresql://postgres:postgres@127.0.0.1:${String(55431 + serviceNumber)}/postgres`,
      password: "postgres",
    };
    const stopped = serviceStatus(serviceDescriptor.id, name);
    const ready = serviceStatus(serviceDescriptor.id, name, "ready");
    return {
      id: serviceDescriptor.id,
      service: "database",
      name,
      describe: Effect.succeed(serviceDescriptor).pipe(
        Effect.mapError(() => new StackRuntimeError({ message: "unused" })),
      ),
      status: Effect.succeed(stopped),
      credentials: Effect.succeed(credentials),
      prepare: Effect.succeed({
        instances: [{ id: serviceDescriptor.id, service: "database", artifacts: [] }],
      }),
      start: Effect.gen(function* () {
        if (events.blockStart) {
          events.starts = (events.starts ?? 0) + 1;
          if (events.startEntered !== undefined)
            yield* Deferred.succeed(events.startEntered, undefined);
          yield* Effect.never;
        }
        return ready;
      }),
      sleep: Effect.succeed(serviceStatus(serviceDescriptor.id, name, "dormant")),
      stop: Effect.succeed(stopped),
      restart: () => Effect.succeed(ready),
      destroy: Effect.sync(() => {
        events.destroys?.push(serviceDescriptor.id);
      }),
      exportSnapshot: ({ destination }: { readonly destination: string }) =>
        Effect.promise(() => Bun.write(destination, "snapshot")).pipe(
          Effect.as(snapshotDescriptor(serviceDescriptor.id)),
        ),
      restoreSnapshot: ({ source }: { readonly source: string }) =>
        Effect.gen(function* () {
          events.restores.push(source);
          if (events.restoreFailures !== undefined && events.restoreFailures > 0) {
            events.restoreFailures -= 1;
            return yield* Effect.fail(new StackRuntimeError({ message: "snapshot is corrupt" }));
          }
          return snapshotDescriptor(serviceDescriptor.id);
        }),
      logs: () => Effect.succeed({ cursor: { opaque: "" }, entries: [], running: false }),
      followLogs: () => Stream.empty,
      followStatus: Stream.fromIterable(
        events.pendingSnapshot
          ? [
              {
                ...stopped,
                pendingOperation: { id: "restore", kind: "restoreSnapshot" as const },
              },
              stopped,
            ]
          : [stopped],
      ),
    };
  };
  const primaryService = makeService("database");
  function createService(
    options: EffectCreateServiceOptions<"database">,
  ): Effect.Effect<EffectServiceInstance<"database">, StackServiceError>;
  function createService<K extends ServiceKind>(
    options: EffectCreateServiceOptions<K>,
  ): Effect.Effect<EffectServiceInstance<K>, StackServiceError>;
  function createService(options: AnyEffectCreateServiceOptions) {
    if (options.service !== "database") return Effect.die("unused service kind");
    const name = options.name ?? "unnamed";
    events.creates.push(name);
    if (options.initialization !== undefined) events.initializations?.push(options.initialization);
    const candidate = makeService(events.mismatchedCandidate ? "other-shadow" : name);
    if (events.uncertainCreate) {
      uncertainCandidate = candidate;
      return Effect.fail(
        Object.assign(
          new UncertainOperationError({
            stackId,
            mutation: "create",
            message: "create response was lost",
          }),
          { expectedCreationInputsId: "creation:shadow" },
        ),
      );
    }
    return Effect.succeed(candidate);
  }
  const services: EffectServiceCollection = {
    create: createService,
    get: (ref) =>
      "name" in ref && ref.name === "database"
        ? Effect.succeed(primaryService)
        : uncertainCandidate === undefined
          ? Effect.die("unused")
          : Effect.succeed(uncertainCandidate),
    list: Effect.succeed([]),
  };
  const status: StackStatus = {
    id: stackId,
    lifecycle: "running",
    desiredLifecycle: "running",
    runtime: nativeRuntime,
    endpoints: {},
    versions: {},
    capabilities: [],
    artifacts: [],
    instances: [],
  };
  return {
    id: stackId,
    services,
    status: Effect.succeed(status),
    followStatus: Stream.empty,
    credentials: Effect.succeed({
      database: { url: Redacted.make(credentialsUrl), password: Redacted.make("postgres") },
    }),
    prepare: () => Effect.succeed({ instances: [] }),
    start: () => Effect.succeed(status),
    sleep: () => Effect.succeed(status),
    restart: () => Effect.succeed(status),
    stop: () => Effect.succeed(status),
    destroy: () => Effect.void,
    logs: () => Effect.succeed({ cursor: { opaque: "" }, entries: [], running: false }),
    followLogs: () => Stream.empty,
  };
};

const credentialsUrl = "postgresql://postgres:postgres@127.0.0.1:55430/postgres";

const apiLayer = (stack: EffectStack) => {
  let exists = false;
  const found = {
    id: stack.id,
    projectRoot: tmp.current,
    name: "default",
    branchContext: "main",
    runtime: nativeRuntime,
    desiredLifecycle: "stopped" as const,
  };
  return Layer.succeed(StackApi, {
    findStack: () => Effect.succeed(exists ? Option.some(found) : Option.none()),
    createStack: () =>
      Effect.sync(() => {
        exists = true;
        return stack;
      }),
    openStack: () => Effect.succeed(stack),
    inspectStack: () => Effect.die("unused"),
    discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
  });
};

const layers = (stack: EffectStack, catalog: ReturnType<typeof recordingStackCatalogSetup>) =>
  Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    mockOutput().layer,
    apiLayer(stack),
    catalog.layer,
  );

describe("stackAcquireShadowDatabase", () => {
  it.live("creates and starts a generic database service for a cold shadow", () => {
    const events = { creates: [], initializations: [], restores: [], destroys: [] };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup((value) => value.target.kind);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const handle = yield* stackAcquireShadowDatabase(input(fs, path), { bypassCache: true });
      expect(events.creates).toHaveLength(1);
      expect(events.initializations).toEqual([{ from: serviceId("service-1") }]);
      expect(handle.service.service).toBe("database");
      expect(catalog.applied).toEqual(["service"]);
      yield* stackReleaseShadowDatabase(handle);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("publishes a cold snapshot and restores it through the service API", () => {
    const events = { creates: [], restores: [], destroys: [] };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const first = yield* withEnvVar(
        "SUPABASE_HOME",
        home,
        withEnvVar(
          SHADOW_CACHE_ENV,
          "1",
          stackAcquireShadowDatabase(input(fs, path), { runtime: nativeRuntime }),
        ),
      );
      expect(first.baselinePresent).toBe(false);
      const names = yield* fs.readDirectory(path.join(home, "cache", "shadow-baseline"));
      const tarNames = names.filter((name) => name.endsWith(".tar"));
      expect(tarNames).toHaveLength(1);
      expect(tarNames[0]).toMatch(/^stack-shadow-baseline-[0-9a-f]{16}\.tar$/u);
      yield* stackReleaseShadowDatabase(first);
      const second = yield* withEnvVar(
        "SUPABASE_HOME",
        home,
        withEnvVar(
          SHADOW_CACHE_ENV,
          "1",
          stackAcquireShadowDatabase(input(fs, path), { runtime: nativeRuntime }),
        ),
      );
      expect(second.baselinePresent).toBe(true);
      expect(events.restores).toHaveLength(1);
      yield* stackReleaseShadowDatabase(second);
      expect(catalog.applied).toEqual([undefined]);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("discards a corrupt cached snapshot before creating a fresh service", () => {
    const events: {
      creates: string[];
      restores: string[];
      destroys: string[];
      restoreFailures?: number;
    } = {
      creates: [],
      restores: [],
      destroys: [],
    };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* withEnvVar(
        "SUPABASE_HOME",
        home,
        withEnvVar(
          SHADOW_CACHE_ENV,
          "1",
          stackAcquireShadowDatabase(input(fs, path), { runtime: nativeRuntime }).pipe(
            Effect.flatMap(stackReleaseShadowDatabase),
          ),
        ),
      );
      events.restoreFailures = 1;
      const handle = yield* withEnvVar(
        "SUPABASE_HOME",
        home,
        withEnvVar(
          SHADOW_CACHE_ENV,
          "1",
          stackAcquireShadowDatabase(input(fs, path), { runtime: nativeRuntime }),
        ),
      );
      expect(events.creates).toHaveLength(3);
      expect(events.restores).toHaveLength(1);
      expect(catalog.applied).toEqual([undefined, undefined]);
      yield* stackReleaseShadowDatabase(handle);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("waits for a pending snapshot operation before destroying its owned service", () => {
    const events = { creates: [], restores: [], destroys: [], pendingSnapshot: true };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stackWithShadowDatabase(input(fs, path), () => Effect.void, { bypassCache: true });
      expect(events.destroys).toHaveLength(1);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("does not destroy a mismatched candidate after an uncertain create", () => {
    const events = {
      creates: [],
      restores: [],
      destroys: [],
      uncertainCreate: true,
      mismatchedCandidate: true,
    };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const acquired = yield* Effect.exit(
        stackAcquireShadowDatabase(input(fs, path), { bypassCache: true }),
      );
      expect(Exit.isFailure(acquired)).toBe(true);
      expect(events.destroys).toHaveLength(0);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("reuses an uncertain candidate only when its requested profile matches", () => {
    const events = {
      creates: [],
      restores: [],
      destroys: [],
      uncertainCreate: true,
    };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const handle = yield* stackAcquireShadowDatabase(input(fs, path), { bypassCache: true });
      expect(handle.service.name).toContain("shadow-");
      expect(events.destroys).toHaveLength(0);
      yield* stackReleaseShadowDatabase(handle);
      expect(events.destroys).toHaveLength(1);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live(
    "retains a candidate with a different initialization profile after uncertain create",
    () => {
      const events = {
        creates: [],
        restores: [],
        destroys: [],
        uncertainCreate: true,
        profileMismatch: true,
      };
      const stack = fakeStack(events);
      const catalog = recordingStackCatalogSetup(() => undefined);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const acquired = yield* Effect.exit(
          stackAcquireShadowDatabase(input(fs, path), { bypassCache: true }),
        );
        expect(Exit.isFailure(acquired)).toBe(true);
        expect(events.destroys).toHaveLength(0);
      }).pipe(Effect.provide(layers(stack, catalog)));
    },
  );

  it.live("keeps two independently acquired targets isolated", () => {
    const events = { creates: [], restores: [], destroys: [] };
    const stack = fakeStack(events);
    const catalog = recordingStackCatalogSetup(() => undefined);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* stackAcquireShadowDatabase(input(fs, path), { bypassCache: true });
      const second = yield* stackAcquireShadowDatabase(input(fs, path), { bypassCache: true });
      expect(first.service.id).not.toBe(second.service.id);
      expect(events.creates).toHaveLength(2);
      yield* stackReleaseShadowDatabase(first);
      yield* stackReleaseShadowDatabase(second);
      expect(events.destroys).toHaveLength(2);
    }).pipe(Effect.provide(layers(stack, catalog)));
  });

  it.live("cancels blocked startup and destroys the registered service", () => {
    return Effect.gen(function* () {
      const startEntered = yield* Deferred.make<void>();
      const events = {
        creates: [],
        restores: [],
        destroys: [],
        blockStart: true,
        starts: 0,
        startEntered,
      };
      const stack = fakeStack(events);
      const catalog = recordingStackCatalogSetup(() => undefined);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fiber = yield* Effect.forkChild(
          stackAcquireShadowDatabase(input(fs, path), { bypassCache: true }),
        );
        yield* Deferred.await(startEntered);
        expect(events.starts).toBe(1);
        yield* Fiber.interrupt(fiber);
        expect(events.destroys).toHaveLength(1);
      }).pipe(Effect.provide(layers(stack, catalog)));
    });
  });
});
