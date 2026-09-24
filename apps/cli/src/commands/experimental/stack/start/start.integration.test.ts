import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Redacted, Stream } from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";
import type {
  ServiceCreation,
  ServiceCreationInput,
  ServiceInstance,
  ServiceInstances,
  StackCredentials,
  Stack,
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
): ServiceInstances[ServiceCreation["service"]] => {
  const status = (config: ServiceCreation) => ({
    id,
    endpoints:
      config.service === "database"
        ? [{ name: "sql", protocol: "tcp" as const, host: "127.0.0.1", port: 23456 }]
        : [],
    config,
    lifecycle: "stopped" as const,
    health: undefined,
    error: undefined,
    cleanupError: undefined,
    exit: undefined,
    currentOperation: undefined,
    launchId: undefined,
    intentRevision: 0,
    wakeEnabled: false,
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
    status: Effect.succeed(status(creation)),
    followStatus: Stream.empty,
    logs: Stream.empty,
    credentials: () => Effect.succeed({}),
  } satisfies Omit<ServiceInstance, "service">;
  switch (creation.service) {
    case "database":
      return {
        ...base,
        service: "database",
        credentials: () =>
          Effect.succeed({ databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" }),
        exportSnapshot: () => Effect.die("unused"),
        restoreSnapshot: () => Effect.die("unused"),
        resetData: Effect.die("unused"),
      };
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

const withIdentity = (creation: ServiceCreation, identity: StackCredentials): ServiceCreation => {
  switch (creation.service) {
    case "database":
      return {
        ...creation,
        config: { ...creation.config, jwtSecret: Redacted.make(identity.jwtSecret) },
      };
    case "rest":
      return {
        ...creation,
        config: { ...creation.config, jwtSecret: identity.jwtSecret, jwks: identity.jwks },
      };
    case "auth":
      return {
        ...creation,
        config: {
          ...creation.config,
          jwtSecret: identity.jwtSecret,
          gotrueJwtKeys: identity.gotrueJwtKeys,
        },
      };
    case "realtime":
      return {
        ...creation,
        config: { ...creation.config, jwtSecret: identity.jwtSecret, jwks: identity.jwks },
      };
    case "storage":
      return {
        ...creation,
        config: {
          ...creation.config,
          jwtSecret: identity.jwtSecret,
          jwks: identity.jwks,
          anonKey: identity.anonKey,
          serviceRoleKey: identity.serviceRoleKey,
        },
      };
    case "functions":
      return {
        ...creation,
        config: {
          ...creation.config,
          jwtSecret: identity.jwtSecret,
          jwks: identity.jwks,
          anonKey: identity.anonKey,
          serviceRoleKey: identity.serviceRoleKey,
          publishableKey: identity.publishableKey,
          secretKey: identity.secretKey,
        },
      };
    case "studio":
      return {
        ...creation,
        config: {
          ...creation.config,
          jwtSecret: identity.jwtSecret,
          anonKey: identity.anonKey,
          serviceRoleKey: identity.serviceRoleKey,
          publishableKey: identity.publishableKey,
          secretKey: identity.secretKey,
        },
      };
    case "pooler":
      return { ...creation, config: { ...creation.config, jwtSecret: identity.jwtSecret } };
    default:
      return creation;
  }
};

const fakeStack = () => {
  let members: Array<ServiceInstances[keyof ServiceInstances]> = [];
  let stopped = 0;
  let composed = 0;
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
    publicSigningKeys: "[]",
    remoteJwks: "[]",
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
      get: Effect.succeed(savedCredentials),
    },
    composition: {
      describe: Effect.sync(() => ({
        members: members.map(({ id }) => ({ id, activation: "eager" as const })),
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
            publicSigningKeys: "[]",
            remoteJwks: options?.identity?.remoteJwks ?? "[]",
            ...options?.identity,
          };
          members = creations.map((creation) =>
            instance(
              withIdentity(requireConcreteCreation(creation), savedCredentials),
              `${creation.service}-member`,
            ),
          );
          return members;
        }),
      configure: () => Effect.void,
      start: Effect.succeed([]),
      stop: Effect.sync(() => {
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
  };
};

const layers = (root: string, fixture: ReturnType<typeof fakeStack>, output = mockOutput()) => {
  const telemetry = mockTelemetryStateTracked();
  const target = Layer.succeed(StackTargetResolver, {
    resolve: () => Effect.succeed({ projectRoot: root, runtime: "native" as const }),
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
    Layer.succeed(StackCatalogSetup, { apply: () => Effect.void }),
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
      const base = layers(root, fixture);
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
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "rest")).toBe(true);
      expect(fixture.composed).toBe(2);
      yield* stackStart(flags(["studio"])).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(false);
      expect(fixture.stopped).toBe(2);
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(true);
      expect(fixture.stopped).toBe(3);
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(5);
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
      const changedEnv = yield* stackStart(flags()).pipe(
        Effect.provide(layers(root, fixture)),
        Effect.flip,
      );
      expect(changedEnv).toBeInstanceOf(StackCommandStartError);
      if (!(changedEnv instanceof StackCommandStartError))
        return yield* Effect.die("Expected a stack configuration error");
      expect(changedEnv.reason).toBe("invalid-config");
      expect(fixture.members.find(({ service }) => service === "database")?.id).toBe(databaseId);
      const refreshed = fixture.members.find(({ service }) => service === "functions");
      if (refreshed?.service !== "functions") return yield* Effect.die("Functions missing");
      expect(refreshed.id).toBe(functionsId);
      const refreshedStatus = yield* refreshed.status;
      if (refreshedStatus.config.service === "functions")
        expect(refreshedStatus.config.config.env).toEqual({ CUSTOM_VALUE: "hello" });
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

  it.live("restarts services when the configured JWT secret changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-jwt-rotation-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "jwt-rotation"\n');
      const fixture = fakeStack();
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(1);

      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "jwt-rotation"\n[auth]\njwt_secret = "a-new-jwt-secret-with-at-least-32-characters"\n',
      );
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.stopped).toBe(1);
      expect(fixture.composed).toBe(2);
      expect(fixture.members.find(({ service }) => service === "auth")?.service).toBe("auth");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "rejects changed Postgres root keys and database versions before stopping the stack",
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
          const error = yield* stackStart(flags(["studio"])).pipe(
            Effect.provide(layers(root, fixture)),
            Effect.flip,
          );
          expect(error).toMatchObject({ reason: "invalid-config" });
          expect(fixture.stopped).toBe(0);
          expect(fixture.composed).toBe(1);
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
