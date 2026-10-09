import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
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
import { postgresVersion } from "@supabase/stack/internal/artifacts";
import {
  StackError,
  type ServiceCreation,
  type ServiceCreationInput,
  type ServiceInstance,
  type ServiceInstances,
  type StackCredentials,
  type Stack,
} from "@supabase/stack/effect";
import { planSupabaseComposition } from "@supabase/stack/internal/composition";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withEnvVar,
} from "../../../../../tests/helpers/command-mocks.ts";
import { containerEngineSpawner } from "../../../../../tests/helpers/child-process-spawner.ts";
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
import { StackCatalogSetup } from "../../../../command-internal/stack-catalog-setup.ts";
import { ExperimentalFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../../../shared/output/output.layer.ts";
import { StackApi, stackApiLayer, StackTargetResolver } from "../stack.shared.ts";
import { stackStart } from "./start.handler.ts";
import { StackCommandStartError } from "./start.errors.ts";
import { cliConfigValuesTestLayer } from "../../../../../tests/helpers/config-values-layer.ts";

const flags = (exclude: ReadonlyArray<string> = []) => ({
  exclude,
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  preparation: "background" as const,
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
        : config.service === "rest" || config.service === "studio"
          ? [
              {
                name: "http",
                protocol: "http" as const,
                host: "127.0.0.1",
                port: config.service === "rest" ? 23457 : 23458,
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
              ...("version" in input ? { version: input.version } : {}),
              ...("endpoints" in input ? { endpoints: input.endpoints } : {}),
              config: { ...current.config, ...input.config },
            };
          }),
        status: Effect.sync(() => status(current)),
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
    };
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
            return instance(requireConcreteCreation(creation), id, () => memberView(id));
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
      plan: (creations: ReadonlyArray<ServiceCreationInput>) =>
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
    setMemberStatus(id: string, status: MemberStatus) {
      memberStatuses.set(id, status);
    },
    /** Readiness survives composition start, which awaits only eager members. */
    setMemberReadiness(id: string, ready: Effect.Effect<void, StackError>) {
      memberReadiness.set(id, ready);
    },
  };
};

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
        hostRunning: false,
      }),
  });
  const api = Layer.succeed(StackApi, {
    create: () => Effect.succeed(fixture.stack),
    open: () => Effect.succeed(fixture.stack),
    discover: () => Effect.succeed([]),
    find: () => Effect.die("identity not used"),
    findDeleted: () => Effect.die("identity not used"),
  });
  return Layer.mergeAll(
    cliConfigValuesTestLayer,
    BunServices.layer,
    runtimeInfo,
    output.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: root, explicitWorkdir }),
    target,
    api,
    Layer.succeed(ExperimentalFlag, false),
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

const machineEnvelope = Schema.decodeEffect(
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

describe("experimental stack start", () => {
  it.live("rejects incompatible Functions env before changing composition", () =>
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

  it.live("rejects malformed configuration before creating a stack", () =>
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

  it.live(
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

  it.live(
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

  it.live("applies capability selection across repeated starts", () =>
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

  it.live("reports connection details and lazy services once the stack is ready", () =>
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
      const data = json.messages.find(({ data }) => data !== undefined)?.data as {
        endpoints: Readonly<Record<string, unknown>>;
      };
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
      expect(data.endpoints).not.toHaveProperty("studio.mcp");

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

  it.live("returns the connection env for an already-running stack in JSON", () =>
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
      const data = json.messages.find(({ data }) => data !== undefined)?.data as {
        env: Readonly<Record<string, string>>;
      };
      expect(data.env).toMatchObject({
        API_URL: "http://127.0.0.1:23457",
        MCP_URL: "http://127.0.0.1:23457/mcp",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:23456/postgres",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("returns the connection env for a resumed stack in JSON", () =>
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
      const data = json.messages.find(({ data }) => data !== undefined)?.data as {
        env: Readonly<Record<string, string>>;
      };
      expect(data.env.DB_URL).toBe("postgresql://postgres:postgres@127.0.0.1:23456/postgres");
      expect(data.env.API_URL).toBe("http://127.0.0.1:23457");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("names the services that failed when the composition start fails", () =>
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

  it.live("loads Functions env only when Functions are selected", () =>
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

  it.live("rejects Studio without REST before changing the composition", () =>
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

  it.live("applies signing-key file changes only after the stack is stopped", () =>
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

  it.live("recomposes a stopped stack with its existing IDs without rerunning catalog setup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-stopped-restart-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "stopped-restart"\n');
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

  it.live("creates the supabase_functions schema once when restarting a stack without it", () =>
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

  it.live("skips invalid config while running and reports it after stop", () =>
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

  it.live("rejects a partially active stack before reading changed config", () =>
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

  it.live("rejects a stack whose database alone was started before reading changed config", () =>
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

  it.live(
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

  it.live("fails a start while a woken lazy member is still booting and never becomes ready", () =>
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
          new StackError({ operation: "service.ready", message: "auth HTTP readiness timed out" }),
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

  it.live("rejects changed Postgres root keys and database versions after stopping the stack", () =>
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

  it.live("applies changed service configuration after the stack is stopped", () =>
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

  it.live("names the config key and both values when a saved port changes", () =>
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

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "port-config"\n[api]\nport = 54999\n',
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
      // The rejection leaves the stopped composition untouched: no recompose was attempted.
      expect(fixture.composed).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("names a dedicated (non-shared) port's own config key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-dedicated-port-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "dedicated-port"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "dedicated-port"\n[studio]\nport = 12345\n',
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

  // The production planner (`fixedApiPorts`/`withSharedApiPort`) normalizes a requested
  // automatic shared-API port to the composition's already-fixed value whenever one exists, so a
  // saved fixed port going back to automatic in `config.toml` reuses the saved port rather than
  // failing. This locks down that non-obvious compatible case: it is not an incompatible path.
  it.live(
    "accepts a shared API port going from fixed back to automatic, reusing the saved port",
    () =>
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
        // Does not throw: the planner treats this as compatible (`change: "unchanged"`), not an
        // incompatible path to report. Reusing the already-bound port for the resumed instance is
        // `packages/stack`'s own concern, not asserted here.
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
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

  it.live("names the env var override when SUPABASE_*_PORT set the saved port", () =>
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

  it.live(
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

  it.live(
    "names the full Postgres build, not major_version, when only the pinned build differs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-pg-build-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "pg-build"\n[db]\nmajor_version = 17\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const database = fixture.members.find(({ service }) => service === "database");
        if (database?.service !== "database") return yield* Effect.die("Database missing");
        const observed = yield* database.status;
        if (observed.config.service !== "database")
          return yield* Effect.die("Database config missing");
        const pinnedVersion = postgresVersion("17");
        // A saved build the current catalog no longer pins (`postgresVersion` only normalizes a
        // recognized alias): same major as the requested `17`, different full build.
        yield* database.restart({
          config: { ...observed.config.config, version: "17.0.0-stale-build" },
        });
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining(
            `Postgres build: saved 17.0.0-stale-build, requested ${pinnedVersion}`,
          ),
        });
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError) {
          expect(error.message).not.toContain("major_version");
          expect(error.suggestion).not.toContain("Revert");
          expect(error.suggestion).toContain(
            "This CLI release starts a different Postgres build than the saved stack.",
          );
          expect(error.suggestion).toContain(
            `supabase stack destroy --stack-id ${fixture.stack.id}`,
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "drops the revert sentence for an artifact-version-only mismatch and explains the fix in plain language",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-artifact-version-" });
        yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "artifact-version"\n',
        );
        const fixture = fakeStack();
        yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
        const rest = fixture.members.find(({ service }) => service === "rest");
        if (rest?.service !== "rest") return yield* Effect.die("REST missing");
        const restObserved = yield* rest.status;
        if (restObserved.config.service !== "rest") return yield* Effect.die("REST config missing");
        yield* rest.restart({ ...restObserved.config, version: "rest-v1-stale" });
        yield* fixture.stack.composition.stop;
        const error = yield* stackStart(flags()).pipe(
          Effect.provide(layers(root, fixture)),
          Effect.flip,
        );

        expect(error).toMatchObject({
          reason: "invalid-config",
          message: expect.stringContaining("rest artifact version"),
        });
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError) {
          expect(error.suggestion).not.toContain("Revert");
          expect(error.suggestion).toContain(
            "This CLI release starts a different rest artifact version than the saved stack.",
          );
          expect(error.suggestion).toContain(
            `supabase stack destroy --stack-id ${fixture.stack.id}`,
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
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
        const rest = fixture.members.find(({ service }) => service === "rest");
        if (rest?.service !== "rest") return yield* Effect.die("REST missing");
        const restObserved = yield* rest.status;
        if (restObserved.config.service !== "rest") return yield* Effect.die("REST config missing");
        yield* rest.restart({ ...restObserved.config, version: "rest-v1-stale" });
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
          // can't unblock start: the non-editable artifact-version change still would.
          message: expect.stringContaining("[studio] port: saved automatic, requested 12345"),
        });
        expect(error).toBeInstanceOf(StackCommandStartError);
        if (error instanceof StackCommandStartError) {
          expect(error.suggestion).not.toContain("Revert");
          expect(error.suggestion).toContain(
            "This CLI release starts a different rest artifact version than the saved stack.",
          );
          expect(error.suggestion).toContain(
            `supabase stack destroy --stack-id ${fixture.stack.id}`,
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("emits structured stack_changes and recreate_command on the JSON error envelope", () =>
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
      const envelope = yield* machineEnvelope(stdio.stdout[0]!);
      expect(envelope._tag).toBe("Error");
      expect(envelope.error).toMatchObject({
        code: "ExperimentalStackStartError",
        message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
      });
      expect(envelope.stack_changes).toEqual([
        {
          service: "database",
          path: "config.version",
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

  it.live("emits the same structured error fields on the stream-json terminal event", () =>
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

      const event = yield* machineEnvelope(stdio.stdout.at(-1)!);
      expect(event.type).toBe("error");
      expect(event.error).toMatchObject({
        code: "ExperimentalStackStartError",
        message: expect.stringContaining("[db] major_version: saved 17, requested 15"),
      });
      expect(event.stack_changes).toEqual([
        {
          service: "database",
          path: "config.version",
          key: "[db] major_version",
          saved: "17",
          requested: "15",
          editable: true,
        },
      ]);
      expect(event.recreate_command).toBe(`supabase stack destroy --stack-id ${fixture.stack.id}`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("always suggests --stack-id for a named stack, naming the stack as plain text", () =>
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

  it.live("matches a Postgres major alias to the saved pinned database version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-postgres-alias-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-postgres-alias"\n[db]\nmajor_version = 17\n[edge_runtime]\nenabled = false\n',
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const database = fixture.members.find(({ service }) => service === "database");
      if (database?.service !== "database") return yield* Effect.die("Database missing");
      const observed = yield* database.status;
      if (observed.config.service !== "database")
        return yield* Effect.die("Database config missing");
      const pinnedVersion = postgresVersion("17");
      expect(pinnedVersion).not.toBe("17");
      yield* database.restart({ config: { ...observed.config.config, version: pinnedVersion } });
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

  it.live(
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
