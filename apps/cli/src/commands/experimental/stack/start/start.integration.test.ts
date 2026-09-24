import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Redacted, Stream } from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";
import { postgresVersion } from "@supabase/stack/internal/postgres-artifact";
import {
  StackError,
  type ServiceCreation,
  type ServiceCreationInput,
  type ServiceInstance,
  type ServiceInstances,
  type StackCredentials,
  type Stack,
} from "@supabase/stack/effect";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
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
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackStart } from "./start.handler.ts";
import { StackCommandStartError } from "./start.errors.ts";

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

const instance = (
  creation: ServiceCreation,
  id: string,
  lifecycle: () => "stopped" | "running",
  wakeEnabled: () => boolean,
): ServiceInstances[ServiceCreation["service"]] => {
  const status = (config: ServiceCreation) => ({
    id,
    endpoints:
      config.service === "database"
        ? [{ name: "sql", protocol: "tcp" as const, host: "127.0.0.1", port: 23456 }]
        : [],
    config,
    lifecycle: lifecycle(),
    health: undefined,
    error: undefined,
    cleanupError: undefined,
    exit: undefined,
    currentOperation: undefined,
    launchId: undefined,
    intentRevision: 0,
    wakeEnabled: wakeEnabled(),
    registered: true,
  });
  const base = {
    id,
    start: Effect.void,
    ready: Effect.void,
    stop: Effect.void,
    restart: () => Effect.void,
    destroy: Effect.void,
    prepare: Effect.void,
    status: Effect.sync(() => status(creation)),
    followStatus: Stream.empty,
    logs: Stream.empty,
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
            if (input?.config.version !== undefined)
              current = {
                ...current,
                config: { ...current.config, version: input.config.version },
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
    case "rest":
      return { ...base, service: "rest" };
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
    case "mail":
      return { ...base, service: "mail" };
    case "analytics":
      return { ...base, service: "analytics" };
    case "vector":
      return { ...base, service: "vector" };
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

const fakeStack = (compositionStart?: Stack["composition"]["start"]) => {
  let members: Array<ServiceInstances[keyof ServiceInstances]> = [];
  let stopped = 0;
  let composed = 0;
  let gatewayConfigured = 0;
  let gatewayPort: number | "auto" | undefined;
  let catalogApplied = 0;
  let lifecycle: "stopped" | "running" = "stopped";
  let activations = new Map<string, "eager" | "lazy">();
  const memberStatuses = new Map<
    string,
    { readonly lifecycle?: "stopped" | "running"; readonly wakeEnabled?: boolean }
  >();
  let savedCredentials: StackCredentials = {
    jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
    postgresRootKey: DEFAULT_POSTGRES_ROOT_KEY,
    databasePassword: DEFAULT_LOCAL_DATABASE_PASSWORD,
    publishableKey: "sb_publishable_test",
    secretKey: "sb_secret_test",
    anonKey: "anon-token",
    serviceRoleKey: "service-token",
    jwks: '{"keys":[]}',
    gotrueJwtKeys: "[]",
    remoteJwks: "[]",
    anonKeyIsOverride: false,
    serviceRoleKeyIsOverride: false,
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
    gateway: {
      configure: ({ port, tls }) =>
        Effect.sync(() => {
          gatewayConfigured += 1;
          gatewayPort = port;
          const assignedPort = port === "auto" ? 54321 : port;
          const hostScheme = tls === undefined ? "http" : "https";
          return {
            hostUrl: `${hostScheme}://127.0.0.1:${assignedPort}`,
            runtimeUrl: `http://127.0.0.1:${assignedPort}`,
          };
        }),
    },
    composition: {
      describe: Effect.sync(() => ({
        members: members.map(({ id }) => ({ id, activation: activations.get(id) ?? "eager" })),
        dependencies: [],
      })),
      supabase: (creations: ReadonlyArray<ServiceCreationInput>, options) =>
        Effect.sync(() => {
          composed += 1;
          const database = creations.find((creation) => creation.service === "database");
          const jwtSecret =
            database?.service === "database" && database.config.jwtSecret !== undefined
              ? Redacted.value(database.config.jwtSecret)
              : DEFAULT_LOCAL_JWT_SECRET;
          savedCredentials = {
            jwtSecret,
            postgresRootKey:
              database?.service === "database" && database.config.rootKey !== undefined
                ? Redacted.value(database.config.rootKey)
                : DEFAULT_POSTGRES_ROOT_KEY,
            databasePassword:
              database?.service === "database" && database.config.databasePassword !== undefined
                ? Redacted.value(database.config.databasePassword)
                : DEFAULT_LOCAL_DATABASE_PASSWORD,
            publishableKey: options?.identity?.publishableKey ?? "sb_publishable_test",
            secretKey: options?.identity?.secretKey ?? "sb_secret_test",
            anonKey: options?.identity?.anonKey ?? "anon-token",
            serviceRoleKey: options?.identity?.serviceRoleKey ?? "service-token",
            jwks: '{"keys":[]}',
            gotrueJwtKeys: options?.identity?.gotrueJwtKeys ?? "[]",
            remoteJwks: options?.identity?.remoteJwks ?? "[]",
            anonKeyIsOverride: options?.identity?.anonKeyIsOverride ?? false,
            serviceRoleKeyIsOverride: options?.identity?.serviceRoleKeyIsOverride ?? false,
          };
          const previousMembers = members;
          members = creations.map((creation) => {
            const previous = previousMembers.find(({ service }) => service === creation.service);
            const id =
              previous !== undefined && options?.reuseIds?.includes(previous.id)
                ? previous.id
                : `${creation.service}-member-${composed}`;
            return instance(
              requireConcreteCreation(creation),
              id,
              () => memberStatuses.get(id)?.lifecycle ?? lifecycle,
              () =>
                memberStatuses.get(id)?.wakeEnabled ??
                (lifecycle === "running" && activations.get(id) === "lazy"),
            );
          });
          activations = new Map(members.map(({ id }) => [id, "eager"]));
          return members;
        }),
      configure: ({ members: configured }) =>
        Effect.sync(() => {
          activations = new Map(configured.map(({ id, activation }) => [id, activation]));
        }),
      start:
        compositionStart ??
        Effect.sync(() => {
          lifecycle = "running";
          return [];
        }),
      stop: Effect.sync(() => {
        lifecycle = "stopped";
        stopped += 1;
        return [];
      }),
      restart: Effect.succeed([]),
    },
    stop: Effect.void,
    destroy: Effect.void,
    tools: { run: () => Effect.die("tool not used") },
  };
  return {
    stack,
    get members() {
      return members;
    },
    get stopped() {
      return stopped;
    },
    get composed() {
      return composed;
    },
    get gatewayConfigured() {
      return gatewayConfigured;
    },
    get gatewayPort() {
      return gatewayPort;
    },
    get catalogApplied() {
      return catalogApplied;
    },
    applyCatalog() {
      catalogApplied += 1;
    },
    get savedCredentials() {
      return savedCredentials;
    },
    setMemberStatus(
      id: string,
      status: { readonly lifecycle?: "stopped" | "running"; readonly wakeEnabled?: boolean },
    ) {
      memberStatuses.set(id, status);
    },
  };
};

const layers = (
  root: string,
  fixture: ReturnType<typeof fakeStack>,
  output = mockOutput(),
  existing = true,
) => {
  const telemetry = mockTelemetryStateTracked();
  const target = Layer.succeed(StackTargetResolver, {
    resolve: () =>
      Effect.succeed({
        projectRoot: root,
        ...(existing ? { id: fixture.stack.id } : {}),
        runtime: "native" as const,
      }),
  });
  const api = Layer.succeed(StackApi, {
    create: () => Effect.succeed(fixture.stack),
    open: () => Effect.succeed(fixture.stack),
    discover: () => Effect.succeed([]),
    resolveIdentity: () => Effect.die("identity not used"),
  });
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    output.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: root }),
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
        resolveIdentity: () => Effect.die("identity not used"),
      });
      const result = yield* stackStart(flags()).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(base, api)),
      );
      expect(result).toMatchObject({ reason: "invalid-config" });
      expect(created).toBe(false);
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
            endpoints: {
              "database.sql": {
                protocol: "tcp",
                address: "127.0.0.1",
                port: 23456,
                url: "tcp://127.0.0.1:23456",
              },
            },
          },
        }),
      );
      expect(fixture.members.map(({ service }) => service)).toEqual(["database"]);
      expect(fixture.composed).toBe(1);
      expect(fixture.gatewayConfigured).toBe(0);
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
      expect(fixture.gatewayConfigured).toBe(1);
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
              { id: "vector-member-1", succeeded: false, error: "Service health timed out" },
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
        detail: "vector (vector-member-1): Service health timed out",
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
      const configured = yield* fixture.stack.composition.describe;
      expect(configured.members.find(({ id }) => id === functionsId)?.activation).toBe("lazy");
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

  it.live.each([
    {
      name: "signing-key",
      projectId: "key-rotation-deferred",
      changedConfig:
        'project_id = "key-rotation-deferred"\n[auth]\nsigning_keys_path = "missing-keys.json"\n',
      expectedError: "failed to read signing keys",
    },
    {
      name: "TLS",
      projectId: "api-tls-deferred",
      changedConfig:
        'project_id = "api-tls-deferred"\n[api.tls]\nenabled = true\ncert_path = "missing-cert.pem"\nkey_path = "missing-key.pem"\n',
      expectedError: "failed to read TLS cert",
    },
  ] as const)("skips $name file reads while running and reports them after stop", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: `stack-start-${testCase.name}-deferred-`,
      });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        `project_id = "${testCase.projectId}"\n`,
      );
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));

      yield* fs.writeFileString(`${root}/supabase/config.toml`, testCase.changedConfig);
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(1);
      expect(fixture.gatewayConfigured).toBe(1);
      expect(fixture.stopped).toBe(0);

      yield* fixture.stack.composition.stop;
      const error = yield* stackStart(flags()).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "invalid-config" });
      expect(error.message).toContain(testCase.expectedError);
      expect(fixture.composed).toBe(1);
      expect(fixture.gatewayConfigured).toBe(1);
      expect(fixture.stopped).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("refreshes Auth template mappings only after the stack stops", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-auth-templates-" });
      const canonicalRoot = yield* fs.realPath(root);
      yield* fs.makeDirectory(`${root}/supabase/templates`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/templates/first.html`, "first");
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "auth-template-refresh"\n[auth.email.template.invite]\ncontent_path = "./supabase/templates/first.html"\n',
      );
      const fixture = fakeStack();

      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.gatewayPort).toBe("auto");
      const firstAuth = fixture.members.find(({ service }) => service === "auth");
      if (firstAuth?.service !== "auth") return yield* Effect.die("Auth member missing");
      const firstStatus = yield* firstAuth.status;
      if (firstStatus.config.service !== "auth") return yield* Effect.die("Auth config missing");
      expect(firstStatus.config.config.templates).toEqual([
        { id: "invite", filePath: `${canonicalRoot}/supabase/templates/first.html` },
      ]);

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "auth-template-refresh"\n[auth.email.template.invite]\ncontent_path = "./supabase/templates/second.html"\n',
      );
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(1);

      yield* fixture.stack.composition.stop;
      yield* fs.writeFileString(`${root}/supabase/templates/second.html`, "second");
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      const refreshedAuth = fixture.members.find(({ service }) => service === "auth");
      if (refreshedAuth?.service !== "auth") return yield* Effect.die("Auth member missing");
      const refreshedStatus = yield* refreshedAuth.status;
      if (refreshedStatus.config.service !== "auth")
        return yield* Effect.die("Auth config missing");
      expect(refreshedStatus.config.config.templates).toEqual([
        { id: "invite", filePath: `${canonicalRoot}/supabase/templates/second.html` },
      ]);
      expect(fixture.composed).toBe(2);
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
});
