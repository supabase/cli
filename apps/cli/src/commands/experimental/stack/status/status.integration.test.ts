import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Redacted, Stream } from "effect";
import { type Observation, type ServiceCreation, StackError } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import type { StackStatusFlags } from "./status.command.ts";
import { stackStatus } from "./status.handler.ts";

const stackId = "a".repeat(64);
type StatusOutputFormat = "text" | "json" | "stream-json";
type OpenedStack = Effect.Success<ReturnType<(typeof StackApi.Service)["open"]>>;
type StackInstance = Effect.Success<OpenedStack["services"]["list"]>[number];
const jwtSecret = "status-test-jwt-secret-with-at-least-32-chars";
const database: ServiceCreation = {
  service: "database",
  config: {
    version: "17",
    databasePassword: Redacted.make("postgres"),
    jwtSecret: Redacted.make(jwtSecret),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: 54322 } },
};
const rest: ServiceCreation = {
  service: "rest",
  config: { databaseUrl: "postgresql://placeholder" },
  endpoints: { http: { port: 54321 } },
};
const flags = (input?: Partial<StackStatusFlags>): StackStatusFlags => ({
  stack: Option.none(),
  stackId: Option.none(),
  env: false,
  overrideName: [],
  ...input,
});

const makeObservation = (
  id: string,
  config: ServiceCreation,
  input: Partial<Observation> = {},
): Observation => ({
  id,
  endpoints: [],
  config,
  lifecycle: "stopped",
  health: undefined,
  error: undefined,
  cleanupError: undefined,
  exit: undefined,
  currentOperation: undefined,
  launchId: undefined,
  intentRevision: 1,
  wakeEnabled: true,
  registered: true,
  ...input,
});

const makeService = (input: {
  readonly id: string;
  readonly creation: ServiceCreation;
  readonly observation?: Observation;
  readonly statusCalls: { value: number };
  readonly statusError?: StackError;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly rejectCredentials?: boolean;
}): StackInstance => ({
  id: input.id,
  service: input.creation.service,
  start: Effect.die("unused"),
  ready: Effect.die("unused"),
  stop: Effect.die("unused"),
  restart: () => Effect.die("unused"),
  destroy: Effect.die("unused"),
  prepare: Effect.die("unused"),
  status: Effect.suspend(() => {
    input.statusCalls.value += 1;
    if (input.statusError !== undefined) return Effect.fail(input.statusError);
    return input.observation === undefined
      ? Effect.die("status must not run")
      : Effect.succeed(input.observation);
  }),
  followStatus: Stream.empty,
  logs: Stream.empty,
  credentials: () =>
    input.rejectCredentials
      ? Effect.die("credentials must not run")
      : Effect.succeed(input.credentials ?? {}),
  exportSnapshot: () => Effect.die("unused"),
  restoreSnapshot: () => Effect.die("unused"),
  resetData: Effect.die("unused"),
});

const makeStack = (
  services: ReadonlyArray<StackInstance>,
  members: ReadonlyArray<{ readonly id: string; readonly activation: "eager" | "lazy" }>,
): OpenedStack => ({
  id: stackId,
  services: {
    create: (_creation) => Effect.die("unused"),
    get: (_id) => Effect.die("unused"),
    list: Effect.succeed([...services]),
  },
  composition: {
    supabase: (_services, _options) => Effect.die("unused"),
    configure: (_config) => Effect.die("unused"),
    describe: Effect.succeed({ members: [...members], dependencies: [] }),
    start: Effect.die("unused"),
    stop: Effect.die("unused"),
    restart: Effect.die("unused"),
  },
  stop: Effect.die("unused"),
  destroy: Effect.die("unused"),
  tools: {
    run: (_tool, _options) => Effect.die("unused"),
  },
});

const runStatus = (input: {
  readonly services: ReadonlyArray<StackInstance>;
  readonly members?: ReadonlyArray<{ readonly id: string; readonly activation: "eager" | "lazy" }>;
  readonly reachable?: boolean;
  readonly outputFormat?: StatusOutputFormat;
  readonly config?: "missing" | "invalid" | "explicit";
  readonly flags?: StackStatusFlags;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-status-" });
    if (input.config === "invalid") {
      yield* fs.makeDirectory(`${root}/supabase`);
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "broken\n[auth\n');
    }
    if (input.config === "explicit") {
      yield* fs.makeDirectory(`${root}/supabase`);
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "status-test"\n[db]\nport = 54322\n',
      );
    }
    const projectRoot = root;
    const stack = makeStack(
      input.services,
      input.members ?? input.services.map(({ id }) => ({ id, activation: "lazy" as const })),
    );
    const definition = {
      id: stackId,
      identity: {
        projectRoot,
        branchContext: "status-branch",
        stackName: "status-stack",
      },
      runtime: "native" as const,
      instances: input.services.map(({ id, service }) => ({
        id,
        creation: service === "database" ? database : rest,
      })),
      composition: { members: input.members ?? [], dependencies: [] },
      ports: [],
    };
    const api = Layer.succeed(StackApi, {
      create: () => Effect.die("create must not run"),
      open: () => Effect.succeed(stack),
      discover: () =>
        Effect.succeed([
          {
            definition,
            host:
              input.reachable === false
                ? undefined
                : {
                    stackId,
                    identity: definition.identity,
                    pid: 123,
                    port: 4567,
                  },
          },
        ]),
      resolveIdentity: () => Effect.succeed(definition.identity),
    });
    const resolver = Layer.succeed(StackTargetResolver, {
      resolve: (target) =>
        Effect.succeed({
          projectRoot: target.projectRoot,
          id: stackId,
          runtime: "native" as const,
        }),
    });
    const out = mockOutput({ format: input.outputFormat ?? "text" });
    const telemetry = mockTelemetryStateTracked();
    const layer = Layer.mergeAll(
      api,
      resolver,
      out.layer,
      telemetry.layer,
      mockCommandSettings({ workdir: projectRoot, supabaseHome: root }),
      BunServices.layer,
      runtimeInfoLayer,
    );
    const effect = stackStatus(input.flags ?? flags()).pipe(Effect.provide(layer));
    return { effect, out, root };
  }).pipe(Effect.provide(BunServices.layer));

it.live("reports observed lifecycle and health without requesting credentials", () =>
  Effect.gen(function* () {
    const databaseCalls = { value: 0 };
    const restCalls = { value: 0 };
    const authCalls = { value: 0 };
    const auth: ServiceCreation = {
      service: "auth",
      config: { databaseUrl: "postgresql://placeholder", jwtSecret },
      endpoints: { http: { port: 54325 } },
    };
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls: databaseCalls,
        observation: makeObservation("database-id", database, {
          lifecycle: "running",
          health: "healthy",
          wakeEnabled: false,
          endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
        }),
      }),
      makeService({
        id: "rest-id",
        creation: rest,
        statusCalls: restCalls,
        observation: makeObservation("rest-id", rest, {
          endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
        }),
      }),
      makeService({
        id: "auth-id",
        creation: auth,
        statusCalls: authCalls,
        observation: makeObservation("auth-id", auth, {
          lifecycle: "running",
          health: "unhealthy",
        }),
      }),
    ];
    const run = yield* runStatus({ services, reachable: true });
    yield* run.effect;
    expect(run.out.stdoutText).toContain("Owner: reachable");
    expect(run.out.stdoutText).toContain("database (database-id): running");
    expect(run.out.stdoutText).toContain("rest (rest-id): sleeping");
    expect(run.out.stdoutText).toContain("auth (auth-id): unhealthy");
    expect(run.out.stdoutText).toContain("health=unhealthy");
    expect(run.out.stdoutText).toContain("Readiness: unhealthy");
    expect(databaseCalls.value).toBe(1);
    expect(restCalls.value).toBe(1);
    expect(authCalls.value).toBe(1);
  }),
);

it.live("preserves service status failures and marks aggregate readiness unavailable", () =>
  Effect.gen(function* () {
    const run = yield* runStatus({
      services: [
        makeService({
          id: "database-id",
          creation: database,
          statusCalls: { value: 0 },
          statusError: new StackError({
            operation: "status",
            message: "owner disconnected while observing database",
          }),
        }),
      ],
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data;
    expect(result).toMatchObject({
      owner: "reachable",
      lifecycle: null,
      readiness: "unavailable",
      services: [{ error: "owner disconnected while observing database" }],
    });
  }),
);

it.live("does not label a requested stop as an unexpected process exit", () =>
  Effect.gen(function* () {
    const stopped = makeObservation("database-id", database, {
      lifecycle: "stopped",
      wakeEnabled: false,
      exit: Exit.fail({ _tag: "ServiceError", operation: "exit", message: "SIGTERM" }),
    });
    const unexpected = makeObservation("rest-id", rest, {
      lifecycle: "stopped",
      wakeEnabled: false,
      error: { _tag: "ServiceError", operation: "exit", message: "exit code 1" },
    });
    const run = yield* runStatus({
      services: [
        makeService({
          id: "database-id",
          creation: database,
          statusCalls: { value: 0 },
          observation: stopped,
        }),
        makeService({
          id: "rest-id",
          creation: rest,
          statusCalls: { value: 0 },
          observation: unexpected,
        }),
      ],
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data;
    expect(result).toMatchObject({
      services: [
        { id: "database-id", state: "stopped" },
        { id: "rest-id", state: "exited" },
      ],
    });
  }),
);

it.live("reports stopped readiness without treating unbound endpoints as drift", () =>
  Effect.gen(function* () {
    const run = yield* runStatus({
      services: [
        makeService({
          id: "database-id",
          creation: database,
          statusCalls: { value: 0 },
          observation: makeObservation("database-id", database, {
            lifecycle: "stopped",
            health: undefined,
            wakeEnabled: false,
          }),
        }),
      ],
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data;
    expect(result).toMatchObject({
      readiness: "stopped",
      config_drift: { status: "unchanged" },
    });
  }),
);

it.live("does not report port drift when a stopped service has no live binding", () =>
  Effect.gen(function* () {
    const run = yield* runStatus({
      services: [
        makeService({
          id: "database-id",
          creation: database,
          statusCalls: { value: 0 },
          observation: makeObservation("database-id", database, {
            lifecycle: "stopped",
            wakeEnabled: false,
          }),
        }),
      ],
      config: "explicit",
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data;
    expect(result).toMatchObject({ config_drift: { status: "unchanged" } });
  }),
);

it.live("reports changed explicit ports even while a service is stopped", () =>
  Effect.gen(function* () {
    const changed = { ...database, endpoints: { sql: { port: 54329 } } };
    const run = yield* runStatus({
      services: [
        makeService({
          id: "database-id",
          creation: changed,
          statusCalls: { value: 0 },
          observation: makeObservation("database-id", changed, {
            lifecycle: "stopped",
            wakeEnabled: false,
          }),
        }),
      ],
      config: "explicit",
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data;
    expect(result).toMatchObject({
      config_drift: { status: "changed", paths: ["services.database.endpoints.sql"] },
    });
  }),
);

it.live("reports unavailable owner and does not query service status", () =>
  Effect.gen(function* () {
    const statusCalls = { value: 0 };
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls,
      }),
    ];
    const run = yield* runStatus({ services, reachable: false });
    yield* run.effect;
    expect(run.out.stdoutText).toContain("Owner: unavailable");
    expect(run.out.stdoutText).toContain("Lifecycle: unavailable");
    expect(run.out.stdoutText).toContain("database (database-id): unavailable");
    expect(statusCalls.value).toBe(0);
  }),
);

it.live("rejects environment export when the owner is unavailable", () =>
  Effect.gen(function* () {
    const run = yield* runStatus({
      services: [makeService({ id: "database-id", creation: database, statusCalls: { value: 0 } })],
      reachable: false,
      flags: flags({ env: true }),
    });
    const exit = yield* run.effect.pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
      expect(error).toBeDefined();
      if (error !== undefined) expect(error.reason).toBe("lifecycle");
    }
  }),
);

it.live("exports host variables and JWTs only for a running database", () =>
  Effect.gen(function* () {
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls: { value: 0 },
        observation: makeObservation("database-id", database, {
          lifecycle: "running",
          health: "healthy",
          endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
        }),
        rejectCredentials: true,
        credentials: {
          databaseUrl: "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres",
        },
      }),
      makeService({
        id: "rest-id",
        creation: rest,
        statusCalls: { value: 0 },
        observation: makeObservation("rest-id", rest, {
          lifecycle: "running",
          health: "healthy",
          endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
        }),
      }),
    ];
    const run = yield* runStatus({
      services,
      reachable: true,
      flags: flags({ env: true }),
    });
    yield* run.effect;
    expect(run.out.stdoutText).toContain(
      "DB_URL='postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres?connect_timeout=10'",
    );
    expect(run.out.stdoutText).toContain("API_URL='http://127.0.0.1:54321'");
    expect(run.out.stdoutText).toContain("ANON_KEY=");
    expect(run.out.stdoutText).toContain("SERVICE_ROLE_KEY=");
  }),
);

it.live("uses only the composition database for environment export", () =>
  Effect.gen(function* () {
    const shadow = makeObservation("shadow-db", database, {
      lifecycle: "running",
      health: "healthy",
      endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 60000 }],
    });
    const primary = makeObservation("primary-db", database, {
      lifecycle: "running",
      health: "healthy",
      endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
    });
    const run = yield* runStatus({
      services: [
        makeService({
          id: "shadow-db",
          creation: database,
          statusCalls: { value: 0 },
          observation: shadow,
        }),
        makeService({
          id: "primary-db",
          creation: database,
          statusCalls: { value: 0 },
          observation: primary,
        }),
      ],
      members: [{ id: "primary-db", activation: "eager" }],
      reachable: true,
      flags: flags({ env: true }),
    });
    yield* run.effect;
    expect(run.out.stdoutText).toContain("127.0.0.1:54322");
    expect(run.out.stdoutText).not.toContain("127.0.0.1:60000");
  }),
);

it.live("keeps status usable with malformed project configuration", () =>
  Effect.gen(function* () {
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls: { value: 0 },
        observation: makeObservation("database-id", database, {
          lifecycle: "running",
          health: "healthy",
        }),
      }),
    ];
    const run = yield* runStatus({
      services,
      config: "invalid",
      reachable: true,
      outputFormat: "json",
    });
    yield* run.effect;
    expect(run.out.stdoutText).toBe("");
    expect(run.out.messages.find((message) => message.type === "success")?.data).toMatchObject({
      owner: "reachable",
      config_drift: { status: "unavailable" },
    });
  }),
);
