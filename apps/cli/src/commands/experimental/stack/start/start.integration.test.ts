import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";
import { orioledbVersions, type ArtifactPin } from "@supabase/stack/internal/artifacts";
import {
  apiRoute,
  lockSelection,
  readLock,
  StackError,
  type EndpointPortChange,
  type PlanOptions,
  type ServiceCreation,
  type ServiceCreationInput,
  type ServiceInstance,
  type ServiceInstances,
  type StackCredentials,
  type Stack,
  writeLock,
} from "@supabase/stack/effect";
import { planSupabaseComposition } from "@supabase/stack/internal/composition";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withConfigEnv,
  withEnvVar,
} from "../../../../../tests/helpers/command-mocks.ts";
import { containerEngineSpawner } from "../../../../../tests/helpers/child-process-spawner.ts";
import {
  database15,
  orioledb as orioledbPin,
  orioledbConfigVersion,
  selection,
} from "../../../../../tests/helpers/pins.ts";
import {
  publishRelease,
  releaseHostEnv,
  startReleaseFixture,
  type ReleaseFixture,
} from "../../../../../tests/helpers/release-fixture.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { unusedGateway } from "../../../../../tests/helpers/unused-stack.ts";
import {
  DbConnection,
  type DbSession,
} from "../../../../command-internal/db-connection.service.ts";
import { writeProjectLink } from "../../../../command-internal/project-link.ts";
import { StackCatalogSetup } from "../../../../command-internal/stack-catalog-setup.ts";
import { ExperimentalFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { causeDeclaration } from "../../../../shared/telemetry/error-actionability.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import * as HttpClient from "effect/http/HttpClient";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../../../shared/output/output.layer.ts";
import { StackApi, stackApiLayer, StackTargetResolver } from "../stack.shared.ts";
import { stackStart } from "./start.handler.ts";
import { StackCommandStartError } from "./start.errors.ts";

const flags = (exclude: ReadonlyArray<string> = []) => ({
  exclude,
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  preparation: "background" as const,
  frozen: false,
  eager: false,
});

const signingKey = () => ({
  ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "stack-start-rotation-test",
});

const session: DbSession = {
  exec: () => Effect.void,
  execBatch: () => Effect.void,
  query: () => Effect.succeed([]),
  extensionExists: () => Effect.succeed(false),
  copyToCsv: () => Effect.succeed(new Uint8Array()),
  queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
};

/** A database without `supabase_functions` until a webhook template run creates the schema. */
const webhookSchemaDatabase = () => {
  let schemaExists = false;
  let schemaCreations = 0;
  const statements: Array<string> = [];
  const record = (sql: string) => {
    statements.push(sql);
    if (!sql.includes("CREATE SCHEMA supabase_functions")) return;
    schemaExists = true;
    schemaCreations += 1;
  };
  const database: DbSession = {
    ...session,
    exec: (sql) => Effect.sync(() => record(sql)),
    execBatch: (statements) =>
      Effect.sync(() => {
        for (const { sql } of statements) record(sql);
      }),
    query: (sql) =>
      Effect.sync(() =>
        sql.includes("to_regnamespace('supabase_functions')") ? [{ missing: !schemaExists }] : [],
      ),
  };
  return {
    layer: Layer.succeed(DbConnection, { connect: () => Effect.scoped(Effect.succeed(database)) }),
    get schemaCreations() {
      return schemaCreations;
    },
    statements,
  };
};

const instance = (
  creation: ServiceCreation,
  id: string,
  view: () => MemberView,
): ServiceInstances[ServiceCreation["service"]] => {
  const status = (config: ServiceCreation) => ({
    id,
    endpoints:
      config.service === "database"
        ? [{ name: "sql", protocol: "tcp" as const, host: "127.0.0.1", port: 23456 }]
        : apiRoute(config.service) !== undefined || config.service === "studio"
          ? [
              {
                name: "http",
                protocol: "http" as const,
                host: "127.0.0.1",
                port: config.service === "studio" ? 23458 : 23457,
              },
            ]
          : [],
    config,
    lifecycle: view().lifecycle,
    health: view().health,
    error: undefined,
    exit: undefined,
    currentOperation: undefined,
    wakeEnabled: view().wakeEnabled,
  });
  const base = {
    id,
    start: Effect.void,
    ready: Effect.suspend(() => view().ready),
    stop: Effect.void,
    restart: () => Effect.void,
    destroy: Effect.void,
    prepare: Effect.void,
    status: Effect.sync(() => status(creation)),
    followStatus: Stream.empty,
    readLogs: () => Stream.empty,
    credentials: () => Effect.succeed({}),
  } satisfies Omit<ServiceInstance, "service">;
  switch (creation.service) {
    case "database": {
      let current: Extract<ServiceCreation, { service: "database" }> = creation;
      return {
        ...base,
        service: "database",
        restart: (input?: Parameters<ServiceInstances["database"]["restart"]>[0]) =>
          Effect.sync(() => {
            if (input === undefined) return;
            current = {
              ...current,
              ...("endpoints" in input ? { endpoints: input.endpoints } : {}),
              config: { ...current.config, ...input.config },
            };
          }),
        status: Effect.sync(() => {
          const savedPin = view().savedPin;
          return status(savedPin === undefined ? current : { ...current, pin: savedPin });
        }),
        credentials: () =>
          Effect.succeed({ databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" }),
        saveSnapshot: () => Effect.die("unused"),
        restoreSnapshot: () => Effect.die("unused"),
        resetData: Effect.die("unused"),
      };
    }
    case "rest": {
      let current = creation;
      return {
        ...base,
        service: "rest",
        restart: (input?: Parameters<ServiceInstances["rest"]["restart"]>[0]) =>
          Effect.sync(() => {
            if (input !== undefined) current = { ...current, ...input };
          }),
        status: Effect.sync(() => status(current)),
      };
    }
    case "auth":
      return { ...base, service: "auth" };
    case "realtime":
      return { ...base, service: "realtime" };
    case "storage":
      return { ...base, service: "storage" };
    case "imgproxy":
      return { ...base, service: "imgproxy" };
    case "functions": {
      let current = creation;
      return {
        ...base,
        service: "functions",
        restart: (input?: Parameters<ServiceInstances["functions"]["restart"]>[0]) =>
          Effect.sync(() => {
            if (input !== undefined) current = { ...current, config: input.config };
          }),
        status: Effect.sync(() => status(current)),
      };
    }
    case "studio":
      return { ...base, service: "studio" };
    case "pgmeta":
      return { ...base, service: "pgmeta" };
    case "mail": {
      let current = creation;
      return {
        ...base,
        service: "mail",
        restart: (input?: Parameters<ServiceInstances["mail"]["restart"]>[0]) =>
          Effect.sync(() => {
            if (input !== undefined) current = { ...current, ...input };
          }),
        status: Effect.sync(() => status(current)),
      };
    }
    case "analytics":
      return { ...base, service: "analytics" };
    case "pooler":
      return { ...base, service: "pooler" };
  }
};

const requireConcreteCreation = (creation: ServiceCreationInput): ServiceCreation => {
  if (creation.service !== "database") return creation;
  return {
    ...creation,
    config: {
      ...creation.config,
      databasePassword:
        creation.config.databasePassword ?? Redacted.make(DEFAULT_LOCAL_DATABASE_PASSWORD),
      jwtSecret: creation.config.jwtSecret ?? Redacted.make(DEFAULT_LOCAL_JWT_SECRET),
      rootKey: creation.config.rootKey ?? Redacted.make(DEFAULT_POSTGRES_ROOT_KEY),
    },
  };
};

interface MemberView {
  readonly lifecycle: "stopped" | "starting" | "running";
  readonly wakeEnabled: boolean;
  readonly health: "starting" | "healthy" | "unhealthy" | undefined;
  readonly ready: Effect.Effect<void, StackError>;
  readonly savedPin: ArtifactPin | undefined;
}

interface MemberStatus {
  readonly lifecycle?: "stopped" | "starting" | "running";
  readonly wakeEnabled?: boolean;
  readonly health?: "starting" | "healthy" | "unhealthy";
}

const credentialsFor = (
  database: ServiceCreationInput | undefined,
  options: Parameters<Stack["composition"]["supabase"]>[1],
): StackCredentials => {
  const config = database?.service === "database" ? database.config : undefined;
  return {
    jwtSecret:
      config?.jwtSecret === undefined ? DEFAULT_LOCAL_JWT_SECRET : Redacted.value(config.jwtSecret),
    postgresRootKey:
      config?.rootKey === undefined ? DEFAULT_POSTGRES_ROOT_KEY : Redacted.value(config.rootKey),
    databasePassword:
      config?.databasePassword === undefined
        ? DEFAULT_LOCAL_DATABASE_PASSWORD
        : Redacted.value(config.databasePassword),
    publishableKey: options?.keys?.publishableKey ?? "sb_publishable_test",
    secretKey: options?.keys?.secretKey ?? "sb_secret_test",
    anonKey: options?.keys?.anonKey ?? "anon-token",
    serviceRoleKey: options?.keys?.serviceRoleKey ?? "service-token",
    jwks: '{"keys":[]}',
    gotrueJwtKeys: options?.keys?.gotrueJwtKeys ?? "[]",
    remoteJwks: options?.keys?.remoteJwks ?? "[]",
    anonKeyIsOverride: options?.keys?.anonKeyIsOverride ?? false,
    serviceRoleKeyIsOverride: options?.keys?.serviceRoleKeyIsOverride ?? false,
  };
};

const fakeStack = (compositionStart?: Stack["composition"]["start"]) => {
  let members: Array<ServiceInstances[keyof ServiceInstances]> = [];
  const memberCreations = new Map<string, ServiceCreation>();
  let stopped = 0;
  let hostStopped = 0;
  let hostDestroyed = 0;
  let composed = 0;
  let catalogApplied = 0;
  let compositionStarts = 0;
  let lifecycle: "stopped" | "running" = "stopped";
  let activations = new Map<string, "eager" | "lazy">();
  const memberStatuses = new Map<string, MemberStatus>();
  const memberReadiness = new Map<string, Effect.Effect<void, StackError>>();
  const savedPins = new Map<string, ArtifactPin>();
  /** The endpoint changes a simulated owner startup re-planned, until the next `applyStartupReplan`. */
  let pendingStartupChanges: ReadonlyArray<EndpointPortChange> = [];
  let savedCredentials = credentialsFor(undefined, undefined);
  const memberView = (id: string): MemberView => {
    const status = memberStatuses.get(id);
    const memberLifecycle = status?.lifecycle ?? lifecycle;
    return {
      lifecycle: memberLifecycle,
      wakeEnabled:
        status?.wakeEnabled ?? (lifecycle === "running" && activations.get(id) === "lazy"),
      health: status?.health ?? (memberLifecycle === "running" ? "healthy" : undefined),
      ready: memberReadiness.get(id) ?? Effect.void,
      savedPin: savedPins.get(id),
    };
  };
  /** Builds a member from a creation, tracking it for a later `reassignEndpoint`. */
  const buildMember = (id: string, creation: ServiceCreation) => {
    memberCreations.set(id, creation);
    return instance(creation, id, () => memberView(id));
  };
  const stack: Stack = {
    id: "a".repeat(64),
    services: {
      create: <Input extends ServiceCreationInput>(_creation: Input) => Effect.die("unused"),
      get: (id: string) => {
        const found = members.find((entry) => entry.id === id);
        return found === undefined ? Effect.die(`missing instance ${id}`) : Effect.succeed(found);
      },
      get list() {
        return Effect.succeed(members);
      },
    },
    credentials: {
      get: Effect.sync(() => savedCredentials),
    },
    composition: {
      describe: Effect.sync(() => ({
        members: members.map(({ id }) => ({ id, activation: activations.get(id) ?? "eager" })),
        dependencies: [],
      })),
      supabase: (creations: ReadonlyArray<ServiceCreationInput>, options) =>
        Effect.sync(() => {
          composed += 1;
          savedCredentials = credentialsFor(
            creations.find((creation) => creation.service === "database"),
            options,
          );
          const previousMembers = members;
          members = creations.map((creation) => {
            const previous = previousMembers.find(({ service }) => service === creation.service);
            const id =
              previous !== undefined && options?.reuseIds?.includes(previous.id)
                ? previous.id
                : `${creation.service}-member-${composed}`;
            return buildMember(id, requireConcreteCreation(creation));
          });
          activations = new Map(
            members.map(({ id, service }) => [
              id,
              options?.eager === true || service === "database" ? "eager" : "lazy",
            ]),
          );
          return members;
        }),
      // Delegates to the production planner so paths/shared-API-port normalization match what
      // `packages/stack` actually reports, instead of a hand-rolled approximation.
      plan: (creations: ReadonlyArray<ServiceCreationInput>, options?: PlanOptions) =>
        Effect.forEach(members, (member) =>
          member.status.pipe(Effect.map(({ config }) => ({ id: member.id, creation: config }))),
        ).pipe(
          Effect.map((instances) =>
            planSupabaseComposition(
              {
                instances,
                composition: {
                  members: members.map(({ id }) => ({
                    id,
                    activation: activations.get(id) ?? "eager",
                  })),
                  dependencies: [],
                },
              },
              creations,
              options,
            ),
          ),
        ),
      configure: ({ members: configured }) =>
        Effect.sync(() => {
          activations = new Map(configured.map(({ id, activation }) => [id, activation]));
        }),
      start:
        compositionStart ??
        Effect.sync(() => {
          compositionStarts += 1;
          lifecycle = "running";
          memberStatuses.clear();
          return [];
        }),
      stop: Effect.sync(() => {
        lifecycle = "stopped";
        stopped += 1;
        return [];
      }),
      restart: Effect.succeed([]),
    },
    startupEndpointChanges: Effect.sync(() => pendingStartupChanges),
    stop: Effect.sync(() => {
      hostStopped += 1;
    }),
    destroy: Effect.sync(() => {
      hostDestroyed += 1;
    }),
    gateway: unusedGateway,
    commands: { run: () => Effect.die("command not used") },
  };
  return {
    stack,
    get members() {
      return members;
    },
    get stopped() {
      return stopped;
    },
    get hostStopped() {
      return hostStopped;
    },
    get hostDestroyed() {
      return hostDestroyed;
    },
    get composed() {
      return composed;
    },
    /** Whether a detached owner is still up, the way a live stack's would be between calls. */
    get hostRunning() {
      return lifecycle === "running";
    },
    get catalogApplied() {
      return catalogApplied;
    },
    get compositionStarts() {
      return compositionStarts;
    },
    applyCatalog() {
      catalogApplied += 1;
    },
    get savedCredentials() {
      return savedCredentials;
    },
    /** Replaces a member's saved artifact pin, which a real restart cannot change. */
    replaceSavedPin(id: string, pin: ArtifactPin) {
      savedPins.set(id, pin);
    },
    setMemberStatus(id: string, status: MemberStatus) {
      memberStatuses.set(id, status);
    },
    /** Readiness survives composition start, which awaits only eager members. */
    setMemberReadiness(id: string, ready: Effect.Effect<void, StackError>) {
      memberReadiness.set(id, ready);
    },
    /** Simulates a pre-launch endpoint replan: a stopped stack's saved member adopts new endpoints. */
    reassignEndpoint(service: ServiceCreation["service"], endpoints: ServiceCreation["endpoints"]) {
      const member = members.find((entry) => entry.service === service);
      const current = member === undefined ? undefined : memberCreations.get(member.id);
      if (member === undefined || current === undefined) return;
      members = members.map((entry) =>
        entry.id === member.id
          ? buildMember(member.id, { ...current, endpoints } as ServiceCreation)
          : entry,
      );
    },
    /**
     * Simulates the owner's own startup re-plan: every saved member whose only incompatible path
     * is its own endpoint adopts the requested endpoints, the way a real owner boot applies the
     * saved intent to every such member, shared "api" key or dedicated. REST's own change is
     * recorded for `startupEndpointChanges`, since that is the only one whose live port existing
     * tests assert.
     */
    applyStartupReplan(requested: ReadonlyArray<ServiceCreationInput>) {
      // Cleared on every simulated owner startup, not only when a port actually changes, so an
      // unchanged restart after a reported change does not keep reporting it.
      pendingStartupChanges = [];
      // Reads each member's live creation the same way `plan()` does: a member's own `restart`
      // can hold a newer creation (e.g. a changed artifact version) in its own closure, which
      // `memberCreations` never sees again after construction.
      const instances = members.map((member) => ({
        id: member.id,
        creation: Effect.runSync(member.status).config,
      }));
      const liveCreations = new Map(instances.map(({ id, creation }) => [id, creation]));
      const planned = planSupabaseComposition(
        {
          instances,
          composition: {
            members: members.map(({ id }) => ({ id, activation: activations.get(id) ?? "eager" })),
            dependencies: [],
          },
        },
        requested,
        { requestKind: "complete" },
      );
      // A changed endpoint only re-plans when every incompatible member differs in endpoint
      // intents alone; a changed database version (or any other path) blocks the whole re-plan,
      // the way `planEndpointReplan` does.
      const purelyEndpointChanges = planned.every(
        (entry) => !entry.member || entry.change !== "incompatible" || entry.endpointsOnly,
      );
      if (!purelyEndpointChanges) return;
      // The fake never resolves an automatic port for real, so it stands in the same canned
      // value `instance()`'s own status reports for REST, letting a change show up either way.
      const resolvedPort = (port: number | "auto" | undefined) => (port === "auto" ? 23457 : port);
      for (const entry of planned) {
        if (!entry.member || entry.change !== "incompatible") continue;
        const request = requested.find((creation) => creation.service === entry.service);
        if (request === undefined) continue;
        if (entry.service === "rest" && request.service === "rest") {
          const current = liveCreations.get(entry.id);
          const from = resolvedPort(
            current?.service === "rest" ? current.endpoints?.http?.port : undefined,
          );
          const to = resolvedPort(request.endpoints?.http?.port);
          if (from !== undefined && to !== undefined && from !== to)
            pendingStartupChanges = [{ service: "rest", endpoint: "http", from, to }];
        }
        this.reassignEndpoint(request.service, request.endpoints);
      }
    },
  };
};

/** A CI runner sets `CI`, which would freeze the lock between the starts of one test. */
const ciUnsetLayer = ConfigProvider.layerAdd(
  ConfigProvider.fromEnvRecord({ CI: "" }, { preserveEmptyStrings: true }),
  { asPrimary: true },
);

const layers = (
  root: string,
  fixture: ReturnType<typeof fakeStack>,
  output: Pick<ReturnType<typeof mockOutput>, "layer"> = mockOutput(),
  existing = true,
  explicitWorkdir = false,
  // Fixtures request the native runtime, so pin a host that ships native artifacts.
  runtimeInfo = mockRuntimeInfo({ platform: "linux", arch: "x64" }),
) => {
  const telemetry = mockTelemetryStateTracked();
  const target = Layer.succeed(StackTargetResolver, {
    resolve: () =>
      Effect.succeed({
        projectRoot: root,
        ...(existing ? { id: fixture.stack.id } : {}),
        runtime: "native" as const,
        hostRunning: existing && fixture.hostRunning,
      }),
  });
  const api = Layer.succeed(StackApi, {
    create: () => Effect.succeed(fixture.stack),
    open: (options) => {
      if (options.requestedCreations !== undefined)
        fixture.applyStartupReplan(options.requestedCreations);
      return Effect.succeed(fixture.stack);
    },
    discover: () => Effect.succeed([]),
    find: () => Effect.die("identity not used"),
    findDeleted: () => Effect.die("identity not used"),
  });
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfo,
    output.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: root, explicitWorkdir }),
    target,
    api,
    Layer.succeed(ExperimentalFlag, false),
    ciUnsetLayer,
    Layer.succeed(CliArgs, { args: ["stack", "start"] }),
    Layer.succeed(StackCatalogSetup, {
      apply: () => Effect.sync(() => fixture.applyCatalog()),
    }),
    Layer.succeed(DbConnection, { connect: () => Effect.scoped(Effect.succeed(session)) }),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unused")),
    ),
    stdinLayer.pipe(Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false }))),
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
  );
};

const machineEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * A real captured `Stdio` layer, needed only by the JSON/stream-json failure-envelope tests below
 * since `machineErrorContextLayer`'s merge into the error envelope lives inside the real
 * `jsonOutputLayer`/`streamJsonOutputLayer` `fail` implementations, which `mockOutput()` never
 * replicates.
 */
const mockCapturingStdio = () => {
  const stdout: Array<string> = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
      stderr: () => Sink.forEach(() => Effect.void),
    }),
  );
  return { layer, stdout };
};

/**
 * Wires the real `jsonOutputLayer`/`streamJsonOutputLayer` over a captured `Stdio`, with
 * `machineErrorContextLayer` merged alongside it (matching `start.command.ts`'s composition) so
 * the handler and the output layer's `fail` share the same live cell, plus a real
 * `mockProcessControl()` since `withJsonErrorHandling` sets the exit code on it.
 */
const jsonErrorLayers = (
  root: string,
  fixture: ReturnType<typeof fakeStack>,
  format: "json" | "stream-json",
) => {
  const stdio = mockCapturingStdio();
  const processControl = mockProcessControl();
  const outputLayer = format === "json" ? jsonOutputLayer : streamJsonOutputLayer;
  const layer = Layer.mergeAll(
    layers(root, fixture, { layer: outputLayer.pipe(Layer.provide(stdio.layer)) }),
    machineErrorContextLayer,
    processControl.layer,
  );
  return { layer, stdio, processControl };
};

const liveIdleOwner = (root: string, fixture: ReturnType<typeof fakeStack>) =>
  Layer.merge(
    Layer.succeed(StackApi, {
      create: () => Effect.die("unused"),
      open: () => Effect.succeed(fixture.stack),
      discover: () => Effect.succeed([]),
      find: () => Effect.die("identity not used"),
      findDeleted: () => Effect.die("identity not used"),
    }),
    Layer.succeed(StackTargetResolver, {
      resolve: () =>
        Effect.succeed({
          projectRoot: root,
          id: fixture.stack.id,
          runtime: "native" as const,
          hostRunning: true,
        }),
    }),
  );

describe("experimental stack start", () => {
  it.effect("rejects incompatible Functions env before changing composition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-functions-env-" });
      yield* fs.makeDirectory(`${root}/supabase/functions`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "functions-env"\n');
      const fixture = fakeStack();
      for (const [contents, message] of [
        ["INVALID.KEY=value\n", "Environment names"],
        ['VALUE="first\nsecond"\n', "Multiline"],
      ] as const) {
        yield* fs.writeFileString(`${root}/supabase/functions/.env`, contents);
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );
        expect(error).toMatchObject({ reason: "invalid-config" });
        expect(error.message).toContain(message);
        expect(fixture.composed).toBe(0);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects malformed configuration before creating a stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-invalid-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, "[db]\nmajor_version = 14\n");
      let created = false;
      const fixture = fakeStack();
      const base = layers(root, fixture, mockOutput(), false);
      const api = Layer.succeed(StackApi, {
        create: () =>
          Effect.sync(() => {
            created = true;
            return fixture.stack;
          }),
        open: () => Effect.succeed(fixture.stack),
        discover: () => Effect.succeed([]),
        find: () => Effect.die("identity not used"),
        findDeleted: () => Effect.die("identity not used"),
      });
      const result = yield* stackStart(flags()).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(base, api)),
      );
      expect(result).toMatchObject({ reason: "invalid-config" });
      expect(created).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "rejects --runtime native on a platform with no native artifacts before creating a stack",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-start-native-unsupported-",
        });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "unsupported"\n');
        let created = false;
        const fixture = fakeStack();
        const base = layers(
          root,
          fixture,
          mockOutput(),
          false,
          false,
          mockRuntimeInfo({ platform: "win32", arch: "x64" }),
        );
        const api = Layer.succeed(StackApi, {
          create: () =>
            Effect.sync(() => {
              created = true;
              return fixture.stack;
            }),
          open: () => Effect.succeed(fixture.stack),
          discover: () => Effect.succeed([]),
          find: () => Effect.die("identity not used"),
          findDeleted: () => Effect.die("identity not used"),
        });
        const result = yield* stackStart(flags()).pipe(
          Effect.flip,
          Effect.provide(Layer.merge(base, api)),
        );
        expect(result).toMatchObject({
          reason: "flags",
          message: expect.stringContaining("Native artifacts are unsupported on win32/x64"),
        });
        expect(created).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "creates and reports a Podman stack when automatic selection skips a stopped Docker",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-auto-podman-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "auto-podman"\n[edge_runtime]\nenabled = false\n',
        );
        const output = mockOutput();
        const engines = containerEngineSpawner({ docker: "stopped", podman: "running" });
        const fixture = fakeStack();
        const createdRuntimes: Array<string | undefined> = [];
        const overrides = Layer.mergeAll(
          Layer.succeed(StackTargetResolver, {
            resolve: () => Effect.succeed({ projectRoot: root, hostRunning: false }),
          }),
          Layer.succeed(StackApi, {
            create: (options) =>
              Effect.sync(() => {
                createdRuntimes.push(options.runtime);
                return fixture.stack;
              }),
            open: () => Effect.succeed(fixture.stack),
            discover: () => Effect.succeed([]),
            find: () => Effect.die("identity not used"),
            findDeleted: () => Effect.die("deleted stacks not used"),
          }),
          engines.layer,
        );
        yield* stackStart({
          ...flags([
            "rest",
            "auth",
            "realtime",
            "storage",
            "functions",
            "studio",
            "mail",
            "analytics",
            "pooler",
          ]),
          runtime: "auto",
        }).pipe(Effect.provide(Layer.merge(layers(root, fixture, output, false), overrides)));
        expect(createdRuntimes).toEqual(["podman"]);
        expect(output.messages).toContainEqual({
          type: "info",
          message: expect.stringContaining(
            "Docker didn't answer, so this new stack uses the Podman runtime",
          ),
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("applies capability selection across repeated starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-db-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-test"\n[edge_runtime]\nenabled = false\n',
      );
      const fixture = fakeStack();
      const excluded = [
        "rest",
        "auth",
        "realtime",
        "storage",
        "functions",
        "studio",
        "mail",
        "analytics",
        "pooler",
      ];
      const output = mockOutput({ format: "json" });
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture, output)));
      expect(output.messages).toContainEqual(
        expect.objectContaining({
          data: {
            id: fixture.stack.id,
            runtime: "native",
            endpoints: {
              "database.sql": {
                protocol: "tcp",
                address: "127.0.0.1",
                port: 23456,
                url: "tcp://127.0.0.1:23456",
              },
            },
            lazy_services: [],
            env: {
              DB_URL: "postgresql://postgres:postgres@127.0.0.1:23456/postgres",
              PUBLISHABLE_KEY: "sb_publishable_test",
              SECRET_KEY: "sb_secret_test",
              ANON_KEY: "anon-token",
              SERVICE_ROLE_KEY: "service-token",
            },
          },
        }),
      );
      expect(fixture.members.map(({ service }) => service)).toEqual(["database"]);
      expect(yield* fs.exists(`${root}/supabase/snippets`)).toBe(false);
      expect(fixture.composed).toBe(1);
      const repeatedOutput = mockOutput();
      yield* stackStart(flags(excluded)).pipe(
        Effect.provide(layers(root, fixture, repeatedOutput)),
      );
      expect(repeatedOutput.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message:
            "Stack is already running with its current services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
        }),
      );
      expect(fixture.composed).toBe(1);
      expect(fixture.stopped).toBe(0);
      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "rest")).toBe(true);
      expect(yield* fs.exists(`${root}/supabase/snippets`)).toBe(true);
      expect(fixture.composed).toBe(2);
      yield* fixture.stack.composition.stop;
      yield* stackStart(flags(["studio"])).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(false);
      expect(fixture.composed).toBe(3);
      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(true);
      yield* fixture.stack.composition.stop;
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(5);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports connection details and lazy services once the stack is ready", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-summary-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-summary"\n[edge_runtime]\nenabled = false\n',
      );
      const excluded = ["auth", "realtime", "storage", "functions", "mail", "analytics", "pooler"];
      const fixture = fakeStack();
      const json = mockOutput({ format: "json" });
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture, json)));
      const data = json.messages.find(({ data }) => data !== undefined)?.data;
      expect(data).toMatchObject({
        runtime: "native",
        endpoints: {
          "rest.http": { url: "http://127.0.0.1:23457" },
        },
        lazy_services: ["pgmeta", "rest", "studio"],
        env: {
          API_URL: "http://127.0.0.1:23457",
          REST_URL: "http://127.0.0.1:23457/rest/v1",
          DB_URL: "postgresql://postgres:postgres@127.0.0.1:23456/postgres",
          STUDIO_URL: "http://127.0.0.1:23458",
          MCP_URL: "http://127.0.0.1:23457/mcp",
          PUBLISHABLE_KEY: "sb_publishable_test",
          SECRET_KEY: "sb_secret_test",
          ANON_KEY: "anon-token",
          SERVICE_ROLE_KEY: "service-token",
        },
      });
      expect(data?.endpoints).not.toHaveProperty("studio.mcp");

      yield* fixture.stack.composition.stop;
      const text = mockOutput();
      yield* stackStart({ ...flags(excluded), stack: Option.some("feature demo") }).pipe(
        Effect.provide(layers(root, fixture, text, true, true)),
      );
      expect(text.stdoutText).toMatch(/Project URL +│ http:\/\/127\.0\.0\.1:23457 +│/u);
      expect(text.stdoutText).toMatch(/MCP +│ http:\/\/127\.0\.0\.1:23457\/mcp +│/u);
      expect(text.stdoutText).not.toContain("GraphQL");
      expect(text.stdoutText).toMatch(/Secret +│ \S+ +│/u);
      expect(text.stdoutText).toMatch(/rest +│ running · healthy · lazy +│/u);
      // Windows temp paths contain `\` and `~`, so the PowerShell pointer quotes the workdir.
      const workdir = process.platform === "win32" ? `'${root}'` : root;
      expect(text.stdoutText).toContain(
        `Runtime: native\nRun supabase status --env --workdir ${workdir} --stack 'feature demo' to export these values as environment variables.\n`,
      );

      yield* fixture.stack.composition.stop;
      const byPrefix = mockOutput();
      yield* stackStart({
        ...flags(excluded),
        stackId: Option.some(fixture.stack.id.slice(0, 8)),
      }).pipe(Effect.provide(layers(root, fixture, byPrefix, true, true)));
      expect(byPrefix.stdoutText).toContain(
        `Run supabase status --env --workdir ${workdir} --stack-id ${fixture.stack.id} to export`,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns the connection env for an already-running stack in JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-already-running-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "already-running"\n[edge_runtime]\nenabled = false\n',
      );
      const excluded = ["auth", "realtime", "storage", "functions", "mail", "analytics", "pooler"];
      const fixture = fakeStack();
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      const json = mockOutput({ format: "json" });
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture, json)));
      expect(fixture.composed).toBe(1);
      const data = json.messages.find(({ data }) => data !== undefined)?.data;
      expect(data?.env).toMatchObject({
        API_URL: "http://127.0.0.1:23457",
        MCP_URL: "http://127.0.0.1:23457/mcp",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:23456/postgres",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns the connection env for a resumed stack in JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-resumed-env-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "resumed-env"\n[edge_runtime]\nenabled = false\n',
      );
      const excluded = ["auth", "realtime", "storage", "functions", "mail", "analytics", "pooler"];
      const fixture = fakeStack();
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      const rest = fixture.members.find(({ service }) => service === "rest");
      if (rest === undefined) return yield* Effect.die("Expected a REST member");
      // The database stays running; another member starting keeps the composition short of
      // fully started, so the next start takes the resumed branch, not the already-running one.
      fixture.setMemberStatus(rest.id, { lifecycle: "starting", health: "starting" });
      const json = mockOutput({ format: "json" });
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture, json)));
      expect(fixture.compositionStarts).toBe(2);
      expect(fixture.composed).toBe(1);
      const data = json.messages.find(({ data }) => data !== undefined)?.data;
      expect(data?.env).toMatchObject({
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:23456/postgres",
        API_URL: "http://127.0.0.1:23457",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names the services that failed when the composition start fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-outcomes-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-test"\n[edge_runtime]\nenabled = false\n',
      );
      const fixture = fakeStack(
        Effect.fail(
          new StackError({
            operation: "composition.start",
            message: "Composition start had failures",
            outcomes: [
              { id: "database-member-1", succeeded: true },
              { id: "analytics-member-1", succeeded: false, error: "Service health timed out" },
            ],
          }),
        ),
      );
      const error = yield* stackStart(
        flags(["rest", "auth", "realtime", "storage", "functions", "studio", "mail", "pooler"]),
      ).pipe(Effect.provide(layers(root, fixture)), Effect.flip);
      expect(error).toBeInstanceOf(StackCommandStartError);
      expect(error).toMatchObject({
        message: "Composition start had failures",
        detail: "analytics (analytics-member-1): Service health timed out",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("loads Functions env only when Functions are selected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-functions-env-" });
      yield* fs.makeDirectory(`${root}/supabase/functions`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-functions-env"\n[edge_runtime]\nenabled = true\n',
      );
      yield* fs.writeFileString(`${root}/supabase/functions/.env`, 'BROKEN="unterminated\n');
      const fixture = fakeStack();

      yield* stackStart(flags(["functions"])).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "functions")).toBe(false);
      yield* fixture.stack.composition.stop;

      yield* fs.writeFileString(
        `${root}/supabase/functions/.env`,
        "CUSTOM_VALUE=hello\nSUPABASE_SERVICE_ROLE_KEY=ignored\n",
      );
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const functions = fixture.members.find(({ service }) => service === "functions");
      if (functions?.service !== "functions") return yield* Effect.die("Functions missing");
      const database = fixture.members.find(({ service }) => service === "database");
      if (database === undefined) return yield* Effect.die("Database missing");
      const databaseId = database.id;
      const functionsId = functions.id;
      const status = yield* functions.status;
      expect(status.config.service).toBe("functions");
      if (status.config.service !== "functions")
        return yield* Effect.die("Functions configuration missing");
      expect(status.config.config.env).toEqual({ CUSTOM_VALUE: "hello" });
      yield* functions.restart({
        config: { ...status.config.config, bootstrap: "new-generated-bootstrap-template" },
      });
      const composedBeforeRepeat = fixture.composed;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(composedBeforeRepeat);

      const afterGeneratedBootstrap = yield* functions.status;
      if (afterGeneratedBootstrap.config.service !== "functions")
        return yield* Effect.die("Functions configuration missing");
      expect(afterGeneratedBootstrap.config.config.bootstrap).toBe(
        "new-generated-bootstrap-template",
      );

      yield* fs.writeFileString(
        `${root}/supabase/functions/.env`,
        "CUSTOM_VALUE=changed\nSUPABASE_SERVICE_ROLE_KEY=ignored-again\n",
      );
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(composedBeforeRepeat);
      const stillRunning = yield* functions.status;
      if (stillRunning.config.service === "functions")
        expect(stillRunning.config.config.env).toEqual({ CUSTOM_VALUE: "hello" });

      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(composedBeforeRepeat + 1);
      expect(fixture.members.find(({ service }) => service === "database")?.id).toBe(databaseId);
      const refreshed = fixture.members.find(({ service }) => service === "functions");
      if (refreshed?.service !== "functions") return yield* Effect.die("Functions missing");
      expect(refreshed.id).toBe(functionsId);
      const refreshedStatus = yield* refreshed.status;
      if (refreshedStatus.config.service === "functions")
        expect(refreshedStatus.config.config.env).toEqual({ CUSTOM_VALUE: "changed" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects Studio without REST before changing the composition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-studio-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "studio-test"\n');
      const fixture = fakeStack();
      const result = yield* stackStart(flags(["rest"])).pipe(
        Effect.flip,
        Effect.provide(layers(root, fixture)),
      );
      expect(result).toBeInstanceOf(StackCommandStartError);
      expect(result).toMatchObject({ reason: "flags" });
      expect(fixture.stopped).toBe(0);
      expect(fixture.composed).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("applies signing-key file changes only after the stack is stopped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-key-rotation-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      const firstKey = signingKey();
      const secondKey = signingKey();
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "key-rotation"\n[auth]\nsigning_keys_path = "keys.json"\n',
      );
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The stack parser consumes JWK files as JSON.
      yield* fs.writeFileString(`${root}/supabase/keys.json`, JSON.stringify([firstKey]));
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(1);
      const savedKeys = fixture.savedCredentials.gotrueJwtKeys;
      const savedAnonKey = fixture.savedCredentials.anonKey;

      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The stack parser consumes JWK files as JSON.
      yield* fs.writeFileString(`${root}/supabase/keys.json`, JSON.stringify([secondKey]));
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.stopped).toBe(0);
      expect(fixture.composed).toBe(1);
      expect(fixture.savedCredentials.gotrueJwtKeys).toBe(savedKeys);
      expect(fixture.savedCredentials.anonKey).toBe(savedAnonKey);

      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(2);
      expect(fixture.savedCredentials.gotrueJwtKeys).not.toBe(savedKeys);
      expect(fixture.savedCredentials.anonKey).not.toBe(savedAnonKey);
      expect(fixture.members.find(({ service }) => service === "auth")?.service).toBe("auth");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "recomposes a stopped stack with its existing IDs without rerunning catalog setup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-stopped-restart-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "stopped-restart"\n',
        );
        const fixture = fakeStack();

        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const firstIds = fixture.members.map(({ id }) => id);
        expect(fixture.composed).toBe(1);
        expect(fixture.catalogApplied).toBe(1);

        yield* fixture.stack.composition.stop;
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        expect(fixture.composed).toBe(2);
        expect(fixture.members.map(({ id }) => id)).toEqual(firstIds);
        expect(fixture.catalogApplied).toBe(1);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("creates the supabase_functions schema once when restarting a stack without it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-webhook-schema-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "webhook-schema"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const database = webhookSchemaDatabase();

      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(
        Effect.provide(Layer.merge(layers(root, fixture), database.layer)),
      );
      expect(database.schemaCreations).toBe(1);
      const sql = database.statements.join("\n");
      expect(sql).toContain("CREATE FUNCTION supabase_functions.http_request()");
      expect(sql).not.toMatch(/function net\.|grant_pg_net_access|issue_pg_net_access/i);

      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(
        Effect.provide(Layer.merge(layers(root, fixture), database.layer)),
      );
      expect(database.schemaCreations).toBe(1);
      expect(fixture.catalogApplied).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("skips invalid config while running and reports it after stop", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-start-invalid-key-rotation-",
      });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "invalid-key-rotation"\n',
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "invalid-key-rotation"\n[auth]\nsigning_keys_path = "missing-keys.json"\n',
      );
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(1);
      expect(fixture.stopped).toBe(0);

      yield* fixture.stack.composition.stop;
      const error = yield* stackStart(flags()).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "invalid-config" });
      expect(fixture.composed).toBe(1);
      expect(fixture.stopped).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects a partially active stack before reading changed config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-partial-state-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "partial-state"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const database = fixture.members.find(({ service }) => service === "database");
      const auth = fixture.members.find(({ service }) => service === "auth");
      if (database === undefined || auth === undefined)
        return yield* Effect.die("Expected database and Auth members");
      fixture.setMemberStatus(database.id, { lifecycle: "stopped", wakeEnabled: false });
      fixture.setMemberStatus(auth.id, { lifecycle: "stopped", wakeEnabled: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "partial-state"\n[auth]\nsigning_keys_path = "missing-keys.json"\n',
      );

      const error = yield* stackStart(flags()).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );
      expect(error).toMatchObject({
        reason: "lifecycle",
        suggestion: "Run supabase stack stop, then supabase stack start to recover the stack.",
      });
      expect(fixture.stopped).toBe(0);
      expect(fixture.composed).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects a stack whose database alone was started before reading changed config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-db-only-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "db-only"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      for (const member of fixture.members)
        if (member.service !== "database")
          fixture.setMemberStatus(member.id, { lifecycle: "stopped", wakeEnabled: false });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "db-only"\n[auth]\nsigning_keys_path = "missing-keys.json"\n',
      );

      const error = yield* stackStart(flags(["studio"])).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );

      expect(error).toMatchObject({
        reason: "lifecycle",
        message: "The stack is in a partial lifecycle state",
        suggestion: "Run supabase stack stop, then supabase stack start to recover the stack.",
      });
      expect(fixture.compositionStarts).toBe(1);
      expect(fixture.composed).toBe(1);
      expect(fixture.stopped).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "reports a resumed stack ready only after its unhealthy and booting members are ready",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-resume-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "resume"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const rest = fixture.members.find(({ service }) => service === "rest");
        const auth = fixture.members.find(({ service }) => service === "auth");
        if (rest === undefined || auth === undefined)
          return yield* Effect.die("Expected REST and Auth members");
        fixture.setMemberStatus(rest.id, { lifecycle: "running", health: "unhealthy" });
        fixture.setMemberStatus(auth.id, { lifecycle: "starting", health: "starting" });
        const gate = yield* Deferred.make<void>();
        const awaited = yield* Effect.forEach([rest.id, auth.id], (id) =>
          Deferred.make<void>().pipe(
            Effect.tap((waiting) =>
              Effect.sync(() =>
                fixture.setMemberReadiness(
                  id,
                  Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(gate))),
                ),
              ),
            ),
          ),
        );
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "resume"\n[auth]\nsigning_keys_path = "missing-keys.json"\n',
        );
        const output = mockOutput();

        const resuming = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture, output)),
          Effect.forkChild({ startImmediately: true }),
        );
        const firstSettled = yield* Effect.raceFirst(
          Fiber.join(resuming).pipe(Effect.as("reported" as const)),
          Effect.forEach(awaited, Deferred.await, { discard: true }).pipe(
            Effect.as("awaiting readiness" as const),
          ),
        );
        expect(firstSettled).toBe("awaiting readiness");
        expect(fixture.compositionStarts).toBe(2);
        expect(output.messages).not.toContainEqual({ type: "success", message: "Stack is ready." });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(resuming);

        expect(fixture.composed).toBe(1);
        expect(fixture.stopped).toBe(0);
        expect(output.messages).toContainEqual({
          type: "info",
          message:
            "Resuming the saved stack services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
        });
        expect(output.messages).toContainEqual({ type: "success", message: "Stack is ready." });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "fails a start while a woken lazy member is still booting and never becomes ready",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-booting-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "booting"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const auth = fixture.members.find(({ service }) => service === "auth");
        if (auth === undefined) return yield* Effect.die("Expected an Auth member");
        fixture.setMemberStatus(auth.id, { lifecycle: "starting", health: "starting" });
        fixture.setMemberReadiness(
          auth.id,
          Effect.fail(
            new StackError({
              operation: "service.ready",
              message: "auth HTTP readiness timed out",
            }),
          ),
        );
        const output = mockOutput();

        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture, output)),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(StackCommandStartError);
        expect(error).toMatchObject({ message: "auth HTTP readiness timed out" });
        expect(output.messages.map(({ message }) => message)).not.toContain("Stack is ready.");
        expect(output.messages.map(({ message }) => message)).not.toContain(
          "Stack is already running with its current services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "rejects changed Postgres root keys and database versions after stopping the stack",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const [name, changed] of [
          ["root-key", '[db]\nroot_key = "a-different-postgres-root-key"\n'],
          ["version", "[db]\nmajor_version = 15\n"],
        ] as const) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-start-${name}-` });
          yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
          yield* fs.writeFileString(`${root}/supabase/config.toml`, `project_id = "${name}"\n`);
          const fixture = fakeStack();
          yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
          expect(fixture.composed).toBe(1);

          yield* fs.writeFileString(
            `${root}/supabase/config.toml`,
            `project_id = "${name}"\n${changed}`,
          );
          yield* fixture.stack.composition.stop;
          const error = yield* stackStart(flags(["studio"])).pipe(
            Effect.provide(layers(root, fixture)),
            Effect.flip,
          );
          expect(error).toMatchObject({ reason: "invalid-config" });
          expect(fixture.stopped).toBe(1);
          expect(fixture.composed).toBe(1);
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("applies changed service configuration after the stack is stopped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-changed-config-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      const config = (maxRows: number) =>
        `project_id = "changed-config"\n[api]\nmax_rows = ${maxRows}\n[edge_runtime]\nenabled = false\n`;
      yield* fs.writeFileString(`${root}/supabase/config.toml`, config(100));
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const restId = fixture.members.find(({ service }) => service === "rest")?.id;

      yield* fs.writeFileString(`${root}/supabase/config.toml`, config(500));
      yield* fixture.stack.composition.stop;
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      const rest = fixture.members.find(({ service }) => service === "rest");
      if (rest === undefined) return yield* Effect.die("REST missing");
      expect(rest.id).toBe(restId);
      const status = yield* rest.status;
      expect(status.config.service === "rest" ? status.config.config.maxRows : undefined).toBe(500);
      expect(fixture.composed).toBe(2);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "re-plans a changed endpoint on a stopped stack instead of rejecting it, prints the change, and reports none on the next unchanged restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-changed-port-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "changed-port"\n');
        const onlyRest = [
          "auth",
          "realtime",
          "storage",
          "functions",
          "studio",
          "mail",
          "analytics",
          "pooler",
        ];
        const fixture = fakeStack();
        yield* stackStart(flags(onlyRest)).pipe(Effect.provide(layers(root, fixture)));
        const restId = fixture.members.find(({ service }) => service === "rest")?.id;

        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "changed-port"\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;
        const output = mockOutput();
        yield* stackStart(flags(onlyRest)).pipe(Effect.provide(layers(root, fixture, output)));

        const rest = fixture.members.find(({ service }) => service === "rest");
        expect(rest?.id).toBe(restId);
        expect(fixture.composed).toBe(2);
        expect(output.messages.map(({ message }) => message)).toContain("api: 23457 → 54999");

        // A later stop/start with the now-saved config unchanged reports no endpoint change,
        // rather than repeating the one applied by the previous re-plan.
        yield* fixture.stack.composition.stop;
        const secondOutput = mockOutput();
        yield* stackStart(flags(onlyRest)).pipe(
          Effect.provide(layers(root, fixture, secondOutput)),
        );
        expect(secondOutput.messages.some(({ message }) => message.includes("→"))).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("passes requested creations to a live owner, which ignores them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-running-no-replan-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "running-no-replan"\n',
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "running-no-replan"\n[api]\nport = 54999\n',
      );
      // A fully running stack reports "already running" and returns before ever comparing the
      // saved composition against the request. The live owner ignores the requested creations
      // `open` is handed, so the changed endpoint neither re-plans nor rejects.
      const requested: Array<unknown> = [];
      const base = layers(root, fixture);
      const api = Layer.succeed(StackApi, {
        create: () => Effect.die("unused"),
        open: (options) => {
          requested.push(options.requestedCreations);
          return Effect.succeed(fixture.stack);
        },
        discover: () => Effect.succeed([]),
        find: () => Effect.die("identity not used"),
        findDeleted: () => Effect.die("identity not used"),
      });
      const result = yield* stackStart(flags()).pipe(Effect.provide(Layer.merge(base, api)));
      expect(result).toBe(fixture.stack.id);
      expect(requested).toEqual([expect.any(Array)]);
      expect(fixture.composed).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("re-plans when the owner it observed running is gone by the time the stack opens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-owner-gone-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "owner-gone"\n');
      const onlyRest = [
        "auth",
        "realtime",
        "storage",
        "functions",
        "studio",
        "mail",
        "analytics",
        "pooler",
      ];
      const fixture = fakeStack();
      yield* stackStart(flags(onlyRest)).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "owner-gone"\n[api]\nport = 54999\n',
      );
      yield* fixture.stack.composition.stop;
      // The resolver observed a live owner; a concurrent stop finished before `open`, so the
      // fake `open` spawns a fresh owner that re-plans the requested creations.
      const staleSnapshot = Layer.succeed(StackTargetResolver, {
        resolve: () =>
          Effect.succeed({
            projectRoot: root,
            id: fixture.stack.id,
            runtime: "native" as const,
            hostRunning: true,
          }),
      });
      const output = mockOutput();
      yield* stackStart(flags(onlyRest)).pipe(
        Effect.provide(Layer.merge(layers(root, fixture, output), staleSnapshot)),
      );

      expect(output.messages.map(({ message }) => message)).toContain("api: 23457 → 54999");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("adds endpoint_changes to the json and stream-json success payloads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const onlyRest = [
        "auth",
        "realtime",
        "storage",
        "functions",
        "studio",
        "mail",
        "analytics",
        "pooler",
      ];
      const expected = [{ endpoint: "api", keys: ["rest.http"], from: 23457, to: 54999 }];
      const prepare = (prefix: string) =>
        Effect.gen(function* () {
          const root = yield* fs.makeTempDirectoryScoped({ prefix });
          yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
          yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "payload"\n');
          const fixture = fakeStack();
          yield* stackStart(flags(onlyRest)).pipe(Effect.provide(layers(root, fixture)));
          yield* fs.writeFileString(
            `${root}/supabase/config.toml`,
            'project_id = "payload"\n[api]\nport = 54999\n',
          );
          yield* fixture.stack.composition.stop;
          return { root, fixture };
        });

      const json = yield* prepare("stack-start-changes-json-");
      const output = mockOutput({ format: "json" });
      yield* stackStart(flags(onlyRest)).pipe(
        Effect.provide(layers(json.root, json.fixture, output)),
      );
      expect(output.messages).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ endpoint_changes: expected }) }),
      );

      const stream = yield* prepare("stack-start-changes-stream-json-");
      const { layer, stdio } = jsonErrorLayers(stream.root, stream.fixture, "stream-json");
      yield* stackStart(flags(onlyRest)).pipe(Effect.provide(layer));
      const event = yield* machineEnvelope(stdio.stdout.at(-1));
      expect(event.data).toMatchObject({ endpoint_changes: expected });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "lists every endpoints key the shared API listener serves for a re-planned API port",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-changes-keys-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "change-keys"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "change-keys"\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;

        const output = mockOutput({ format: "json" });
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture, output)));

        const apiKeys = [
          "rest.http",
          "auth.http",
          "storage.http",
          "functions.http",
          "realtime.http",
        ];
        expect(output.messages).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              endpoints: expect.objectContaining(
                Object.fromEntries(apiKeys.map((key) => [key, expect.anything()])),
              ),
              endpoint_changes: [
                {
                  endpoint: "api",
                  keys: expect.arrayContaining(apiKeys),
                  from: 23457,
                  to: 54999,
                },
              ],
            }),
          }),
        );
        const [change] = output.messages.flatMap(({ data }) =>
          Array.isArray(data?.endpoint_changes) ? data.endpoint_changes : [],
        );
        expect(change.keys).not.toContain("studio.http");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "advises stop then start, not destroy, when a live idle owner meets a changed port",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-idle-owner-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "idle-owner"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "idle-owner"\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;

        // A live owner keeps its startup state, so `open` never re-plans the requested creations.
        const liveOwner = liveIdleOwner(root, fixture);
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(Layer.merge(layers(root, fixture), liveOwner)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[api] port: saved"),
          suggestion: `Run \`supabase stack stop --stack-id ${fixture.stack.id}\`, then \`supabase stack start --stack-id ${fixture.stack.id}\` to apply the new ports.`,
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "omits recreate_command from the JSON envelope when a live idle owner meets a port",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-idle-json-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "idle-json"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "idle-json"\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;

        const { layer, stdio } = jsonErrorLayers(root, fixture, "json");
        yield* stackStart(flags()).pipe(
          withJsonErrorHandling,
          Effect.provide(Layer.merge(layer, liveIdleOwner(root, fixture))),
        );

        const envelope = yield* machineEnvelope(stdio.stdout[0]);
        expect(envelope._tag).toBe("Error");
        expect(envelope.stack_changes).toEqual(
          expect.arrayContaining([expect.objectContaining({ key: "[api] port" })]),
        );
        expect(envelope).not.toHaveProperty("recreate_command");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "advises destroy and keeps recreate_command when a live idle owner meets a version",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-idle-version-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "idle-version"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "idle-version"\n[db]\nmajor_version = 15\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;

        const { layer, stdio } = jsonErrorLayers(root, fixture, "json");
        yield* stackStart(flags()).pipe(
          withJsonErrorHandling,
          Effect.provide(Layer.merge(layer, liveIdleOwner(root, fixture))),
        );

        const envelope = yield* machineEnvelope(stdio.stdout[0]);
        expect(envelope.error).toMatchObject({
          suggestion: expect.stringContaining(
            `supabase stack destroy --stack-id ${fixture.stack.id}`,
          ),
        });
        expect(envelope.recreate_command).toBe(
          `supabase stack destroy --stack-id ${fixture.stack.id}`,
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "names the config key and the saved port when the owner's startup claim hits a port conflict",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-claim-conflict-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "claim"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "claim"\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;

        const failingOwner = Layer.succeed(StackApi, {
          create: () => Effect.die("unused"),
          open: () =>
            Effect.fail(
              new StackError({
                operation: "startup",
                message:
                  "Stack owner failed to start: Cannot bind api at 0.0.0.0:54999: address already in use (owner log: owner.log)",
                conflict: { port: 54999, endpoint: "api", holder: "foreign" },
              }),
            ),
          discover: () => Effect.succeed([]),
          find: () => Effect.die("identity not used"),
          findDeleted: () => Effect.die("identity not used"),
        });
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(Layer.merge(layers(root, fixture), failingOwner)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          message: expect.stringContaining("Cannot bind api at 0.0.0.0:54999"),
          suggestion: expect.stringMatching(
            /`api\.port` in supabase\/config\.toml.*already saved this port.*previous automatic port is released/,
          ),
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "names the config key and both values when a saved port changes alongside a database version",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-port-config-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "port-config"\n[api]\nport = 54321\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        // A changed port alone on a stopped stack now re-plans instead of failing; pairing it
        // with a database version change, which never re-plans, keeps this error path reachable.
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "port-config"\n[db]\nmajor_version = 15\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[api] port: saved 54321, requested 54999"),
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "names a dedicated (non-shared) port's own config key alongside a database version change",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-dedicated-port-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "dedicated-port"\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        // A changed port alone on a stopped stack now re-plans instead of failing; pairing it
        // with a database version change, which never re-plans, keeps this error path reachable.
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "dedicated-port"\n[db]\nmajor_version = 15\n[studio]\nport = 12345\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[studio] port: saved automatic, requested 12345"),
        });
        // A dedicated port only affects its own service, unlike the shared API port.
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError)
          expect(error.message).not.toContain("[api] port");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "reports a shared API port transitioning from automatic to fixed alongside a database version change",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-api-to-fixed-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "api-to-fixed"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        // A changed port alone on a stopped stack now re-plans instead of failing; pairing it
        // with a database version change, which never re-plans, keeps this error path reachable.
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "api-to-fixed"\n[db]\nmajor_version = 15\n[api]\nport = 54999\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[api] port: saved automatic, requested 54999"),
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  // A saved fixed shared-API port going back to automatic is an incompatible endpoint path, like
  // any other changed port, since every sibling sharing that port reports it; this locks down
  // that it re-plans successfully rather than rejecting the start, the way a single service's own
  // port change does.
  it.effect("accepts a shared API port going from fixed back to automatic by re-planning it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-api-to-auto-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "api-to-auto"\n[api]\nport = 54321\n',
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "api-to-auto"\n');
      yield* fixture.stack.composition.stop;
      // Does not throw: every sibling sharing the "api" port reports a purely-endpoint
      // incompatible path, so the whole composition re-plans instead of rejecting the start.
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "collects simultaneous database-version and port changes into one error with plural revert wording",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-multi-change-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "multi-change"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "multi-change"\n[db]\nmajor_version = 15\n[studio]\nport = 12345\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
        });
        expect(error).toMatchObject({
          message: expect.stringContaining("[studio] port: saved automatic, requested 12345"),
        });
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError)
          expect(error.suggestion).toContain(
            "Revert the settings listed to their saved values to keep the stack and its data",
          );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "names the env var override when SUPABASE_*_PORT set the saved port alongside a database version change",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-port-env-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "port-env"\n');
        const fixture = fakeStack();
        yield* withEnvVar(
          "SUPABASE_API_PORT",
          "54321",
          stackStart(flags()).pipe(Effect.provide(layers(root, fixture))),
        );

        // A changed port alone on a stopped stack now re-plans instead of failing; pairing it
        // with a database version change, which never re-plans, keeps this error path reachable.
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "port-env"\n[db]\nmajor_version = 15\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* withEnvVar(
          "SUPABASE_API_PORT",
          "54999",
          stackStart(flags()).pipe(Effect.provide(layers(root, fixture)), Effect.flip),
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("SUPABASE_API_PORT: saved 54321, requested 54999"),
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "names [db] major_version and the destroy command when the saved Postgres version changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-major-version-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "major-version"\n');
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "major-version"\n[db]\nmajor_version = 15\n',
        );
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
          suggestion: expect.stringContaining(
            `Revert [db] major_version to its saved value to keep the stack and its data, or run \`supabase stack destroy --stack-id ${fixture.stack.id}\` to recreate the stack`,
          ),
        });
        expect(error).toMatchObject({ suggestion: expect.stringContaining("database data") });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "launches the database pin selected by [db] major_version and the stock pin elsewhere",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-selected-pin-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "selected-pin"\n[db]\nmajor_version = 15\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        const pins = new Map<string, ArtifactPin>();
        for (const member of fixture.members) {
          const observed = yield* member.status;
          if (observed.config.service === "database") pins.set("database", observed.config.pin);
          if (observed.config.service === "rest") pins.set("rest", observed.config.pin);
        }
        expect(pins.get("database")).toEqual(database15);
        expect(pins.get("rest")).toEqual(selection.rest);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  const retiredOrioledbPin = (pin: ArtifactPin): ArtifactPin => ({
    ...pin,
    upstreamVersion: "17.0.0.000-orioledb",
    image: "registry.invalid/postgres@sha256:retired",
  });

  const [orioledb = ""] = orioledbVersions();

  /** `supabase start` of `root` with the release host reachable, so an OrioleDB specifier resolves. */
  const startOnHost = (root: string, fixture: ReturnType<typeof fakeStack>, host: ReleaseFixture) =>
    withConfigEnv(releaseHostEnv(host), stackStart(flags())).pipe(
      Effect.provide(layers(root, fixture)),
    );
  const publishOrioledb = (host: ReleaseFixture) => {
    for (let revision = 0; revision <= orioledbPin.revision; revision++)
      publishRelease(host, {
        producer: "postgres",
        upstream: orioledbPin.upstreamVersion,
        revision,
      });
  };
  for (const target of [
    {
      name: "both [db] major_version and [db] orioledb_version when stock 15 becomes OrioleDB 17",
      before: "[db]\nmajor_version = 15\n",
      after: `[db]\norioledb_version = "${orioledb}"\n`,
      env: undefined,
      envVar: "SUPABASE_DB_ORIOLEDB_VERSION",
      changes: `[db] major_version: saved 15, requested 17; [db] orioledb_version: saved unset, requested ${orioledb}`,
      revert: "Revert the settings listed to their saved values",
    },
    {
      name: "SUPABASE_DB_ORIOLEDB_VERSION when it switches a saved stock stack to OrioleDB",
      before: "",
      after: "",
      env: orioledb,
      envVar: "SUPABASE_DB_ORIOLEDB_VERSION",
      changes: `SUPABASE_DB_ORIOLEDB_VERSION: saved unset, requested ${orioledb}`,
      revert: "Revert SUPABASE_DB_ORIOLEDB_VERSION to its saved value",
    },
    {
      name: "the deprecated SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION when it alone switches a saved stock stack to OrioleDB",
      before: "",
      after: "",
      env: orioledb,
      envVar: "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
      changes: `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION: saved unset, requested ${orioledb}`,
      revert: "Revert SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION to its saved value",
    },
  ])
    it.live(`names ${target.name}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* startReleaseFixture;
        publishOrioledb(host);
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-orioledb-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        const configPath = `${root}/supabase/config.toml`;
        yield* fs.writeFileString(configPath, `project_id = "orioledb"\n${target.before}`);
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

        yield* fs.writeFileString(configPath, `project_id = "orioledb"\n${target.after}`);
        yield* fixture.stack.composition.stop;
        const restart = startOnHost(root, fixture, host).pipe(Effect.flip);
        const error = yield* target.env === undefined
          ? restart
          : withEnvVar(target.envVar, target.env, restart);

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: `The saved stack cannot adopt these changes: ${target.changes}`,
          suggestion: expect.stringContaining(
            `${target.revert} to keep the stack and its data, or run \`supabase stack destroy --stack-id ${fixture.stack.id}\``,
          ),
        });
      }).pipe(Effect.provide(BunServices.layer)),
    );

  it.live(
    "warns once about SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION on a first start that includes storage",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* startReleaseFixture;
        publishOrioledb(host);
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-orioledb-alias-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "alias"\n');
        yield* fs.writeFileString(
          `${root}/supabase/.env`,
          `SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION=${orioledb}\n`,
        );
        const fixture = fakeStack();
        const consoleErrors: Array<string> = [];
        const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
          consoleErrors.push(args.map((a) => String(a)).join(" "));
        });
        yield* startOnHost(root, fixture, host).pipe(
          Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())),
        );
        const services = yield* fixture.stack.services.list;
        expect(services.map(({ service }) => service)).toContain("storage");
        expect(
          consoleErrors.filter(
            (line) =>
              line ===
              "WARN: SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION is deprecated and will be removed in v3, use SUPABASE_DB_ORIOLEDB_VERSION instead.",
          ),
        ).toHaveLength(1);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("offers no revert to an OrioleDB build the catalog no longer pins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-retired-orioledb-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "retired"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const database = fixture.members.find(({ service }) => service === "database");
      if (database?.service !== "database") return yield* Effect.die("database missing");
      const observed = yield* database.status;
      if (observed.config.service !== "database") return yield* Effect.die("config missing");
      fixture.replaceSavedPin(database.id, retiredOrioledbPin(observed.config.pin));
      yield* fixture.stack.composition.stop;
      const error = yield* stackStart(flags()).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );

      expect(error).toMatchObject({
        reason: "invalid-config",
        message: expect.stringContaining(
          "[db] orioledb_version: saved 17.0.0.000, requested unset",
        ),
        suggestion: expect.stringContaining(
          "This CLI release starts a different [db] orioledb_version than the saved stack.",
        ),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "uses the destroy-only wording when a non-editable change accompanies an editable one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-mixed-editable-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "mixed-editable"\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const database = fixture.members.find(({ service }) => service === "database");
        if (database?.service !== "database") return yield* Effect.die("Database missing");
        const observed = yield* database.status;
        if (observed.config.service !== "database")
          return yield* Effect.die("Database config missing");
        fixture.replaceSavedPin(database.id, retiredOrioledbPin(observed.config.pin));
        yield* fixture.stack.composition.stop;

        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "mixed-editable"\n[studio]\nport = 12345\n',
        );
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          // The editable change still appears in the message even though reverting it alone
          // can't unblock start: the retired OrioleDB build still would.
          message: expect.stringContaining("[studio] port: saved automatic, requested 12345"),
        });
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError) {
          expect(error.suggestion).not.toContain("Revert");
          expect(error.suggestion).toContain(
            "This CLI release starts a different [db] orioledb_version than the saved stack.",
          );
          expect(error.suggestion).toContain(
            `supabase stack destroy --stack-id ${fixture.stack.id}`,
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("emits structured stack_changes and recreate_command on the JSON error envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-json-envelope-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "json-envelope"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "json-envelope"\n[db]\nmajor_version = 15\n',
      );
      yield* fixture.stack.composition.stop;
      const { layer, stdio } = jsonErrorLayers(root, fixture, "json");
      yield* stackStart(flags()).pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(stdio.stdout).toHaveLength(1);
      const envelope = yield* machineEnvelope(stdio.stdout[0]);
      expect(envelope._tag).toBe("Error");
      expect(envelope.error).toMatchObject({
        code: "ExperimentalStackStartError",
        message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
      });
      expect(envelope.stack_changes).toEqual([
        {
          service: "database",
          path: "pin",
          key: "[db] major_version",
          saved: "17",
          requested: "15",
          editable: true,
        },
      ]);
      expect(envelope.recreate_command).toBe(
        `supabase stack destroy --stack-id ${fixture.stack.id}`,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("emits the same structured error fields on the stream-json terminal event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-stream-json-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "stream-json"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "stream-json"\n[db]\nmajor_version = 15\n',
      );
      yield* fixture.stack.composition.stop;
      const { layer, stdio } = jsonErrorLayers(root, fixture, "stream-json");
      yield* stackStart(flags()).pipe(withJsonErrorHandling, Effect.provide(layer));

      const event = yield* machineEnvelope(stdio.stdout.at(-1));
      expect(event.type).toBe("error");
      expect(event.error).toMatchObject({
        code: "ExperimentalStackStartError",
        message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
      });
      expect(event.stack_changes).toEqual([
        {
          service: "database",
          path: "pin",
          key: "[db] major_version",
          saved: "17",
          requested: "15",
          editable: true,
        },
      ]);
      expect(event.recreate_command).toBe(`supabase stack destroy --stack-id ${fixture.stack.id}`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("always suggests --stack-id for a named stack, naming the stack as plain text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-named-destroy-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "named-destroy"\n');
      const fixture = fakeStack();
      const target = Layer.succeed(StackTargetResolver, {
        resolve: () =>
          Effect.succeed({
            projectRoot: root,
            id: fixture.stack.id,
            name: "feature-a",
            runtime: "native" as const,
            hostRunning: false,
          }),
      });
      yield* stackStart(flags()).pipe(
        Effect.provide(Layer.mergeAll(layers(root, fixture), target)),
      );

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "named-destroy"\n[db]\nmajor_version = 15\n',
      );
      yield* fixture.stack.composition.stop;
      const error = yield* stackStart(flags()).pipe(
        Effect.provide(Layer.mergeAll(layers(root, fixture), target)),
        Effect.flip,
      );

      expect(error).toMatchObject({
        suggestion: expect.stringContaining(
          `supabase stack destroy --stack-id ${fixture.stack.id}\` (stack feature-a)`,
        ),
      });
      expect(error).toBeInstanceOf(StackCommandStartError);
      if (error instanceof StackCommandStartError)
        expect(error.suggestion).not.toContain("--stack feature-a");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reuses the saved database member when the selected pin is unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-same-pin-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-same-pin"\n[db]\nmajor_version = 17\n[edge_runtime]\nenabled = false\n',
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const database = fixture.members.find(({ service }) => service === "database");
      if (database?.service !== "database") return yield* Effect.die("Database missing");
      yield* fixture.stack.composition.stop;

      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.find(({ service }) => service === "database")?.id).toBe(database.id);
      expect(fixture.composed).toBe(2);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  const unreachableDocker = [
    {
      name: "cannot reach the Docker daemon",
      // The `#!/bin/sh` shim is never picked up on Windows, which only resolves `docker.exe` on PATH.
      posixOnly: true,
      message: "Cannot connect to the Docker daemon",
      // A `docker` first on PATH that reports an unreachable daemon, as the real CLI does.
      path: (root: string, inherited: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${root}/bin`);
          yield* fs.writeFileString(
            `${root}/bin/docker`,
            "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///shim/docker.sock. Is the docker daemon running?' >&2\nexit 1\n",
          );
          yield* fs.chmod(`${root}/bin/docker`, 0o755);
          return `${root}/bin:${inherited}`;
        }),
    },
    {
      name: "finds no Docker CLI",
      posixOnly: false,
      message: "docker context show",
      // An empty PATH hides any installed Docker CLI on every platform.
      path: (root: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${root}/empty-bin`);
          return `${root}/empty-bin`;
        }),
    },
  ];

  for (const row of unreachableDocker) {
    it.live.skipIf(row.posixOnly && process.platform === "win32")(
      `leaves no stack registered when a new stack's owner ${row.name}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-create-failure-" });
          yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
          yield* fs.writeFileString(
            `${root}/supabase/config.toml`,
            'project_id = "create-failure"\n',
          );
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- Windows names the variable `Path`; the detached owner inherits it.
          const envKeys = Object.keys(process.env);
          const pathKey = envKeys.find((key) => key.toUpperCase() === "PATH") ?? "PATH";
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the detached host subprocess inherits PATH; this is not application config.
          const path = yield* row.path(root, process.env[pathKey] ?? "");
          yield* withEnvVar(
            pathKey,
            path,
            Effect.gen(function* () {
              const output = mockOutput();
              const target = Layer.succeed(StackTargetResolver, {
                resolve: () =>
                  Effect.succeed({
                    projectRoot: root,
                    runtime: "docker" as const,
                    hostRunning: false,
                  }),
              });
              const api = stackApiLayer.pipe(Layer.provide(BunServices.layer));

              const error = yield* stackStart(flags()).pipe(
                Effect.flip,
                Effect.provide(
                  Layer.mergeAll(layers(root, fakeStack(), output, false), target, api),
                ),
              );
              expect(error.message).toContain(row.message);
              expect(error).toBeInstanceOf(StackCommandStartError);
              if (error instanceof StackCommandStartError) {
                expect(error.reason).toBe("runtime");
                expect(error.suggestion).toContain("Docker CLI or daemon isn't reachable");
              }
              expect(output.stderrText).not.toContain("Failed to stop");

              const stacks = yield* StackApi.pipe(
                Effect.flatMap((stackApi) =>
                  stackApi.discover({ stateRoot: `${root}/.supabase/stacks` }),
                ),
                Effect.provide(api),
              );
              expect(stacks).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }

  it.effect(
    "stops, without destroying, the owner when startup fails after the stack is acquired",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const isExisting of [false, true]) {
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "stack-start-startup-failure-",
          });
          yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
          yield* fs.writeFileString(
            `${root}/supabase/config.toml`,
            'project_id = "startup-failure"\n',
          );
          const fixture = fakeStack(
            Effect.fail(
              new StackError({
                operation: "composition.start",
                message: "Composition start had failures",
              }),
            ),
          );
          const error = yield* Effect.scoped(
            stackStart(flags()).pipe(
              Effect.flip,
              Effect.provide(layers(root, fixture, mockOutput(), isExisting)),
            ),
          );
          expect(error).toBeInstanceOf(StackCommandStartError);
          expect(fixture.hostStopped).toBe(1);
          expect(fixture.hostDestroyed).toBe(0);
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );
});

const lockPath = (root: string) => `${root}/supabase/supabase.lock`;

const REST_OVERRIDE = '[local.services.rest]\nversion = "v99.0.0"\n';

const setConfig = (root: string, config: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(`${root}/supabase/config.toml`, `project_id = "start-lock"\n${config}`),
  );

const lockProject = (config = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-lock-" });
    yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
    yield* setConfig(root, config);
    return root;
  });

const lockText = (root: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(lockPath(root)));

const readProjectLock = (root: string) => readLock(root).pipe(Effect.map(Option.getOrThrow));

/** Publishes `postgrest` `v99.0.0` revisions 0 and 1, so the unpinned specifier resolves to 1. */
const publishRest = (host: ReleaseFixture) => {
  publishRelease(host, { producer: "postgrest", upstream: "v99.0.0", revision: 0 });
  return publishRelease(host, { producer: "postgrest", upstream: "v99.0.0", revision: 1 });
};

/** The artifact pin the fake stack's member of `service` was created with. */
const memberPin = (stack: ReturnType<typeof fakeStack>, service: ServiceCreation["service"]) =>
  stack.members.flatMap((member) =>
    member.service === service ? [Effect.runSync(member.status).config.pin] : [],
  )[0];

/** One `supabase start` of `root`, with `CI` pinned and the release host reachable only when given. */
const lockedStart = (
  root: string,
  options: {
    readonly stack?: ReturnType<typeof fakeStack>;
    readonly host?: ReleaseFixture;
    readonly ci?: boolean;
    readonly frozen?: boolean;
    readonly existing?: boolean;
  } = {},
) => {
  const output = mockOutput();
  const stack = options.stack ?? fakeStack();
  const run = withConfigEnv(
    {
      CI: options.ci === true ? "true" : "",
      ...(options.host === undefined ? {} : releaseHostEnv(options.host)),
    },
    stackStart({ ...flags(), frozen: options.frozen ?? false }),
  ).pipe(Effect.provide(layers(root, stack, output, options.existing)));
  return { output, stack, run };
};

const infoMessages = (output: ReturnType<typeof mockOutput>) =>
  output.messages.flatMap((entry) => (entry.type === "info" ? [entry.message] : []));

const resolvedReports = (output: ReturnType<typeof mockOutput>) =>
  infoMessages(output).filter((message) => message.startsWith("Resolved service versions:"));

const LINKED_BRANCH_REF = "branchprojectrefabcd";

const LINKED_MAIN = {
  project: "projectrefabcdefghijk",
  branch: { ref: "projectrefabcdefghijk", isDefault: true },
};

const COMMIT_WARNING = "Commit supabase/supabase.lock so CI and your team run the same versions.";

describe("experimental stack start service lock", () => {
  it.effect("writes the default lock on the first start and keeps it on later starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* lockProject();
      const first = lockedStart(root);
      yield* first.run;

      const lock = yield* readProjectLock(root);
      expect(lockSelection(lock)).toEqual(selection);
      expect(lock.services.database).toMatchObject({ majorVersion: 17, line: "stock" });
      expect(Object.values(lock.services).map(({ resolution }) => resolution)).toEqual(
        Array.from({ length: 12 }, () => "unlinked"),
      );
      expect(resolvedReports(first.output)).toHaveLength(1);
      expect(resolvedReports(first.output)[0]).toContain("Created supabase/supabase.lock.");
      const gitignore = yield* fs.readFileString(`${root}/supabase/.gitignore`);
      expect(gitignore).toContain(".supabase.lock.lease");
      expect(gitignore).toContain(".supabase.lock.*.tmp");

      const written = yield* lockText(root);
      yield* first.stack.stack.composition.stop;
      const second = lockedStart(root, { stack: first.stack });
      yield* second.run;
      expect(yield* lockText(root)).toBe(written);
      expect(resolvedReports(second.output)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves a version override through the release host and runs the stack on it", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      const latest = publishRest(host);
      const root = yield* lockProject(REST_OVERRIDE);
      const { output, stack, run } = lockedStart(root, { host });
      yield* run;

      const lock = yield* readProjectLock(root);
      expect(lock.services.rest).toMatchObject({
        specifier: "v99.0.0",
        resolution: "resolved",
        resolved: { upstreamVersion: "v99.0.0", revision: 1 },
      });
      expect(lock.services.rest.resolved.image).toContain(latest.digest);
      expect(lock.services.auth.resolved).toEqual(selection.auth);
      expect(memberPin(stack, "rest")).toEqual(lock.services.rest.resolved);
      expect(resolvedReports(output)[0]).toContain("v99.0.0-r1");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("goes back to the bundled version when the override is removed", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject(REST_OVERRIDE);
      yield* lockedStart(root, { host }).run;
      const overridden = yield* readProjectLock(root);

      yield* setConfig(root, "");
      const { output, run } = lockedStart(root, { host, existing: false });
      yield* run;

      const lock = yield* readProjectLock(root);
      expect(lock.services.rest).toMatchObject({ specifier: "linked", resolution: "unlinked" });
      expect(lock.services.rest.resolved).toEqual(selection.rest);
      expect({ ...lock.services, rest: undefined }).toEqual({
        ...overridden.services,
        rest: undefined,
      });
      expect(resolvedReports(output)[0]).toContain("specifier linked ≠ locked v99.0.0");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("restores the linked version when the override is removed, without a new probe", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject(REST_OVERRIDE);
      yield* lockedStart(root, { host }).run;
      const overridden = yield* readProjectLock(root);
      yield* writeLock(root, {
        ...overridden,
        linked: { ...LINKED_MAIN, observedAt: "2026-01-01T00:00:00.000Z" },
        services: {
          ...overridden.services,
          rest: { ...overridden.services.rest, linked: { raw: "99.0.0", version: "v99.0.0" } },
        },
      });

      yield* setConfig(root, "");
      yield* lockedStart(root, { host, existing: false }).run;

      const lock = yield* readProjectLock(root);
      expect(lock.linked).toEqual({ ...LINKED_MAIN, observedAt: "2026-01-01T00:00:00.000Z" });
      expect(lock.services.rest).toMatchObject({
        specifier: "linked",
        resolution: "resolved",
        linked: { version: "v99.0.0" },
        resolved: { upstreamVersion: "v99.0.0", revision: 1 },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("warns when the checkout targets another remote than the lock observed", () =>
    Effect.gen(function* () {
      const root = yield* lockProject();
      yield* lockedStart(root).run;
      const lock = yield* readProjectLock(root);
      yield* writeLock(root, {
        ...lock,
        linked: { ...LINKED_MAIN, observedAt: "2026-01-01T00:00:00.000Z" },
      });
      yield* writeProjectLink(root, {
        project: { ref: LINKED_MAIN.project },
        active_branch: { ref: LINKED_BRANCH_REF, is_default: false },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      const { output, run } = lockedStart(root, { existing: false });
      yield* run;

      expect(output.messages).toContainEqual({
        type: "warn",
        message: `lock observed ${LINKED_MAIN.project}, this checkout targets ${LINKED_MAIN.project}/${LINKED_BRANCH_REF}; run supabase stack update`,
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("warns when this CLI bundles a newer revision of a locked version, offline", () =>
    Effect.gen(function* () {
      const root = yield* lockProject();
      yield* lockedStart(root).run;
      const lock = yield* readProjectLock(root);
      const { database } = lock.services;
      expect(database.resolved.revision).toBeGreaterThan(0);
      yield* writeLock(root, {
        ...lock,
        services: {
          ...lock.services,
          database: {
            ...database,
            resolved: {
              ...database.resolved,
              revision: 0,
              image: database.resolved.image.replace(/-r\d+@/u, "-r0@"),
            },
          },
        },
      });

      const { output, run } = lockedStart(root, { existing: false });
      yield* run;

      const { upstreamVersion, revision } = database.resolved;
      expect(output.messages).toContainEqual({
        type: "warn",
        message: `This CLI bundles newer revisions of locked versions: database ${upstreamVersion}-r0 → ${upstreamVersion}-r${revision}. Run supabase stack outdated to review, supabase stack update to adopt them.`,
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "names [local.services.database] version when a service version swaps the database build",
    () =>
      Effect.gen(function* () {
        const host = yield* startReleaseFixture;
        const root = yield* lockProject();
        const stack = fakeStack();
        yield* lockedStart(root, { stack }).run;
        for (let revision = 0; revision <= orioledbPin.revision; revision++)
          publishRelease(host, {
            producer: "postgres",
            upstream: orioledbPin.upstreamVersion,
            revision,
          });

        yield* setConfig(
          root,
          `[local.services.database]\nversion = "${orioledbPin.upstreamVersion}"\n`,
        );
        yield* stack.stack.composition.stop;
        const error = yield* lockedStart(root, { stack, host }).run.pipe(Effect.flip);

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining(
            `[local.services.database] version: saved ${selection.database.upstreamVersion}-r${selection.database.revision}, requested ${orioledbPin.upstreamVersion}-r${orioledbPin.revision}`,
          ),
        });
        expect(error.message).not.toContain("[db]");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "starts an OrioleDB build the CLI does not bundle once the release host publishes it",
    () =>
      Effect.gen(function* () {
        const host = yield* startReleaseFixture;
        publishRelease(host, {
          producer: "postgres",
          upstream: "17.0.0.000-orioledb",
          revision: 0,
        });
        const root = yield* lockProject('[db]\norioledb_version = "17.0.0.000"\n');
        const { stack, run } = lockedStart(root, { host });
        yield* run;

        const lock = yield* readProjectLock(root);
        expect(lock.services.database).toMatchObject({
          line: "orioledb",
          resolved: { upstreamVersion: "17.0.0.000-orioledb", revision: 0 },
        });
        expect(memberPin(stack, "database")).toEqual(lock.services.database.resolved);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("re-resolves the database when db.major_version changes", () =>
    Effect.gen(function* () {
      const root = yield* lockProject();
      yield* lockedStart(root).run;

      yield* setConfig(root, "[db]\nmajor_version = 15\n");
      const { output, run } = lockedStart(root, { existing: false });
      yield* run;

      const lock = yield* readProjectLock(root);
      expect(lock.services.database).toMatchObject({
        majorVersion: 15,
        line: "stock",
        resolved: database15,
      });
      expect(resolvedReports(output)[0]).toContain("db.major_version 15 ≠ locked 17");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails a frozen start on a missing or stale lock and leaves the project untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject();

      const missing = lockedStart(root, { host, frozen: true });
      const notFound = yield* missing.run.pipe(Effect.flip);
      expect(notFound).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-missing" },
      });
      expect(notFound.message).toContain(
        "supabase/supabase.lock not found; run supabase start locally and commit it",
      );
      expect(yield* fs.exists(lockPath(root))).toBe(false);
      expect(yield* fs.exists(`${root}/supabase/.gitignore`)).toBe(false);

      const stack = fakeStack();
      yield* lockedStart(root, { stack }).run;
      const written = yield* lockText(root);
      const ignored = yield* fs.readFileString(`${root}/supabase/.gitignore`);
      yield* stack.stack.composition.stop;
      yield* lockedStart(root, { stack, frozen: true }).run;
      expect(yield* lockText(root)).toBe(written);

      yield* setConfig(root, REST_OVERRIDE);
      const composed = stack.composed;
      yield* stack.stack.composition.stop;
      const stale = yield* lockedStart(root, { stack, host, frozen: true }).run.pipe(Effect.flip);
      expect(stale).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-stale" },
      });
      expect(stale.message).toContain(
        "supabase/supabase.lock is stale for: rest (specifier v99.0.0 ≠ locked linked); run supabase start locally and commit the updated lock",
      );
      expect(yield* lockText(root)).toBe(written);
      expect(yield* fs.readFileString(`${root}/supabase/.gitignore`)).toBe(ignored);
      expect(stack.composed).toBe(composed);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails a frozen start on a stale lock while the stack is running", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject();
      const stack = fakeStack();
      yield* lockedStart(root, { stack }).run;
      const written = yield* lockText(root);
      const composed = stack.composed;

      yield* setConfig(root, REST_OVERRIDE);
      const stale = yield* lockedStart(root, { stack, host, frozen: true }).run.pipe(Effect.flip);

      expect(stale).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-stale" },
      });
      expect(yield* lockText(root)).toBe(written);
      expect(stack.composed).toBe(composed);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live.each([
    {
      name: "an unpublished release",
      reason: "unpublished",
      message: "no published slim-services release",
      suffix: "invalid_config",
      arrange: (_host: ReleaseFixture) => undefined,
    },
    {
      name: "a release host that is unavailable",
      reason: "transient",
      message: "could not be reached; retry shortly",
      suffix: "network",
      arrange: (host: ReleaseFixture) => {
        publishRest(host);
        host.failing.set("/releases/postgrest-v99.0.0-r0/SHA256SUMS", 503);
      },
    },
    {
      name: "a release that fails verification",
      reason: "integrity",
      message: "the published release failed verification",
      suffix: "asset_checksum",
      arrange: (host: ReleaseFixture) => {
        publishRelease(host, {
          producer: "postgrest",
          upstream: "v99.0.0",
          revision: 0,
          tamperedManifest: true,
        });
      },
    },
  ])("fails the start on $name and writes no lock", (row) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      row.arrange(host);
      const root = yield* lockProject(REST_OVERRIDE);
      const { stack, run } = lockedStart(root, { host });
      const error = yield* run.pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: row.reason },
      });
      expect(error.message).toContain('local.services.rest.version = "v99.0.0"');
      expect(error.message).toContain(row.message);
      expect(causeDeclaration(error)).toMatchObject({ fingerprint_suffix: row.suffix });
      expect(yield* fs.exists(lockPath(root))).toBe(false);
      expect(stack.composed).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves and warns to commit when CI starts without a lock, then freezes it", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject();

      const first = lockedStart(root, { ci: true });
      yield* first.run;
      expect(first.output.messages).toContainEqual({ type: "warn", message: COMMIT_WARNING });
      const written = yield* lockText(root);

      yield* first.stack.stack.composition.stop;
      const second = lockedStart(root, { stack: first.stack, ci: true });
      yield* second.run;
      expect(second.output.messages.filter(({ type }) => type === "warn")).toEqual([]);
      expect(resolvedReports(second.output)).toEqual([]);

      yield* setConfig(root, REST_OVERRIDE);
      yield* first.stack.stack.composition.stop;
      const stale = yield* lockedStart(root, { stack: first.stack, host, ci: true }).run.pipe(
        Effect.flip,
      );
      expect(stale.message).toContain("supabase/supabase.lock is stale for: rest");
      expect(yield* lockText(root)).toBe(written);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses a teammate's committed lock as-is, with no probe, link or login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      publishRest(host);
      const author = yield* lockProject(REST_OVERRIDE);
      yield* lockedStart(author, { host }).run;
      const requests = host.requests.length;
      expect(requests).toBeGreaterThan(0);

      const teammate = yield* lockProject(REST_OVERRIDE);
      yield* fs.copyFile(lockPath(author), lockPath(teammate));
      const { output, stack, run } = lockedStart(teammate, { host });
      yield* run;

      expect(host.requests).toHaveLength(requests);
      expect(resolvedReports(output)).toEqual([]);
      expect(yield* lockText(teammate)).toBe(yield* lockText(author));
      expect(memberPin(stack, "rest")).toMatchObject({ upstreamVersion: "v99.0.0", revision: 1 });
      expect(yield* fs.exists(`${teammate}/supabase/.link.json`)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("serializes concurrent starts on the project lease so the versions resolve once", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject(REST_OVERRIDE);
      const first = lockedStart(root, { host });
      const second = lockedStart(root, { host });
      yield* Effect.all([first.run, second.run], { concurrency: 2 });

      const sums = host.requests.filter((path) => path.endsWith("/SHA256SUMS"));
      expect(sums.length).toBeGreaterThan(0);
      expect(new Set(sums).size).toBe(sums.length);
      expect(resolvedReports(first.output).length + resolvedReports(second.output).length).toBe(1);
      expect(memberPin(first.stack, "rest")).toEqual(memberPin(second.stack, "rest"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("applies default to every service and lets an entry override it", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      publishRest(host);
      const root = yield* lockProject(
        `[local.services.default]\nversion = "bundled"\n[local.services.rest]\nversion = "v99.0.0-r1"\n`,
      );
      yield* lockedStart(root, { host }).run;

      const lock = yield* readProjectLock(root);
      expect(lock.services.auth).toMatchObject({ specifier: "bundled", resolution: "resolved" });
      expect(lock.services.rest).toMatchObject({
        specifier: "v99.0.0-r1",
        resolved: { upstreamVersion: "v99.0.0", revision: 1 },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects orioledb_version next to a different database version", () =>
    Effect.gen(function* () {
      const root = yield* lockProject(
        `[db]\norioledb_version = "${orioledbConfigVersion}"\n[local.services.database]\nversion = "bundled"\n`,
      );
      const error = yield* lockedStart(root).run.pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "invalid-config",
        message: expect.stringContaining("conflicts with local.services.database.version"),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects a database version of another Postgres major than db.major_version", () =>
    Effect.gen(function* () {
      const root = yield* lockProject(
        `[db]\nmajor_version = 15\n[local.services.database]\nversion = "${selection.database.upstreamVersion}"\n`,
      );
      const error = yield* lockedStart(root).run.pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "invalid-config",
        message: expect.stringContaining("requires db.major_version"),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("re-resolves a lock whose database pin was edited to contradict its own entry", () =>
    Effect.gen(function* () {
      const root = yield* lockProject();
      yield* lockedStart(root).run;
      const lock = yield* readProjectLock(root);
      const { database } = lock.services;
      const edits = [
        [{ ...database, majorVersion: 15 }, "db.major_version 17 ≠ locked 15"],
        [{ ...database, line: "orioledb" }, "database line stock ≠ locked orioledb"],
        [
          { ...database, resolved: database15 },
          `locked pin ${database15.upstreamVersion} is not Postgres 17`,
        ],
      ] as const;
      for (const [edited, reason] of edits) {
        yield* writeLock(root, { ...lock, services: { ...lock.services, database: edited } });
        const { output, run } = lockedStart(root, { existing: false });
        yield* run;

        expect(resolvedReports(output)[0]).toContain(reason);
        expect((yield* readProjectLock(root)).services.database.resolved).toEqual(
          selection.database,
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails on a malformed or newer lock whether or not the start is frozen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* lockProject();
      for (const [contents, advice] of [
        ["{ not json", "delete it and run supabase start to resolve the versions again"],
        ['{"lockfileVersion":2}', "upgrade the CLI"],
      ] as const) {
        yield* fs.writeFileString(lockPath(root), contents);
        for (const frozen of [false, true]) {
          const error = yield* lockedStart(root, { frozen }).run.pipe(Effect.flip);
          expect(error).toMatchObject({
            reason: "lock",
            cause: { _tag: "LockResolutionError", reason: "invalid-lock" },
          });
          expect(error.message).toContain(advice);
          expect(yield* lockText(root)).toBe(contents);
        }
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
