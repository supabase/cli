import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  type Observation,
  type PlannedInstance,
  type ServiceCreation,
  type StackCredentials,
  StackError,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { unusedGateway } from "../../../../../tests/helpers/unused-stack.ts";
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
const savedCredentials: StackCredentials = {
  jwtSecret,
  postgresRootKey: "status-test-postgres-root-key",
  databasePassword: "postgres",
  publishableKey: "saved-publishable-key",
  secretKey: "saved-secret-key",
  anonKey: "saved-anon-token",
  serviceRoleKey: "saved-service-token",
  jwks: '{"keys":[]}',
  gotrueJwtKeys: "[]",
  remoteJwks: "[]",
  anonKeyIsOverride: false,
  serviceRoleKeyIsOverride: false,
};
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
  config: {},
  endpoints: { http: { port: 54321 } },
};
const auth: ServiceCreation = {
  service: "auth",
  config: { jwtSecret },
  endpoints: { http: { port: 54321 } },
};
const studio: ServiceCreation = {
  service: "studio",
  config: {},
  endpoints: { http: { port: 54323 } },
};
const functions: ServiceCreation = {
  service: "functions",
  config: {
    functionsRoot: "/project/supabase/functions",
    bootstrap: "export default {};",
    verifyJwt: true,
  },
  endpoints: { http: { port: 54321 } },
};
const storage = (s3ProtocolEnabled: boolean): ServiceCreation => ({
  service: "storage",
  config: {
    filePath: "/project/supabase/.temp/stack-uploads",
    jwtSecret,
    s3ProtocolEnabled,
    s3AccessKeyId: "local-access-key",
    s3SecretAccessKey: "local-secret-key",
    s3Region: "local",
  },
  endpoints: { http: { port: 54321 } },
});
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
  exit: undefined,
  currentOperation: undefined,
  wakeEnabled: true,
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
  readLogs: () => Stream.empty,
  credentials: () =>
    input.rejectCredentials
      ? Effect.die("credentials must not run")
      : Effect.succeed(input.credentials ?? {}),
  saveSnapshot: () => Effect.die("unused"),
  restoreSnapshot: () => Effect.die("unused"),
  resetData: Effect.die("unused"),
});

const makeStack = (
  services: ReadonlyArray<StackInstance>,
  members: ReadonlyArray<{ readonly id: string; readonly activation: "eager" | "lazy" }>,
  credentials: StackCredentials = savedCredentials,
  planned: ReadonlyArray<PlannedInstance> = [],
  credentialsUnavailable = false,
): OpenedStack => ({
  id: stackId,
  services: {
    create: (_creation) => Effect.die("unused"),
    get: (_id) => Effect.die("unused"),
    list: Effect.succeed([...services]),
  },
  credentials: {
    get: credentialsUnavailable
      ? Effect.fail(new StackError({ operation: "credentials", message: "owner unreachable" }))
      : Effect.succeed(credentials),
  },
  composition: {
    plan: () => Effect.succeed(planned),
    supabase: (_services, _options) => Effect.die("unused"),
    configure: (_config) => Effect.die("unused"),
    describe: Effect.succeed({ members: [...members], dependencies: [] }),
    start: Effect.die("unused"),
    stop: Effect.die("unused"),
    restart: Effect.die("unused"),
  },
  startupEndpointChanges: Effect.die("unused"),
  stop: Effect.die("unused"),
  destroy: Effect.die("unused"),
  gateway: unusedGateway,
  commands: {
    run: (_tool, _options) => Effect.die("unused"),
  },
});

const runStatus = (input: {
  readonly services: ReadonlyArray<StackInstance>;
  readonly members?: ReadonlyArray<{ readonly id: string; readonly activation: "eager" | "lazy" }>;
  readonly reachable?: boolean;
  readonly outputFormat?: StatusOutputFormat;
  readonly config?: "missing" | "invalid" | "explicit" | "multiline-functions-env";
  readonly stackCredentials?: StackCredentials;
  readonly credentialsUnavailable?: boolean;
  readonly planned?: ReadonlyArray<PlannedInstance>;
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
    if (input.config === "multiline-functions-env") {
      yield* fs.makeDirectory(`${root}/supabase/functions`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "status-test"\n[edge_runtime]\nenabled = true\n',
      );
      yield* fs.writeFileString(
        `${root}/supabase/functions/.env`,
        'PRIVATE_KEY="-----BEGIN KEY-----\nsecret\n-----END KEY-----"\n',
      );
    }
    const projectRoot = root;
    const stack = makeStack(
      input.services,
      input.members ?? input.services.map(({ id }) => ({ id, activation: "lazy" as const })),
      input.stackCredentials,
      input.planned,
      input.credentialsUnavailable ?? false,
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
      lifetime: "detached" as const,
    };
    const api = Layer.succeed(StackApi, {
      create: () => Effect.die("create must not run"),
      open: () => Effect.succeed(stack),
      discover: () => Effect.die("discover must not run"),
      find: () => Effect.die("find must not run"),
      findDeleted: () => Effect.die("findDeleted must not run"),
    });
    const resolver = Layer.succeed(StackTargetResolver, {
      resolve: (target) =>
        Effect.succeed({
          projectRoot: target.projectRoot,
          id: stackId,
          runtime: "native" as const,
          definition,
          hostRunning: input.reachable !== false,
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

it.live("renders connections and a services summary without internal IDs", () =>
  Effect.gen(function* () {
    const databaseCalls = { value: 0 };
    const restCalls = { value: 0 };
    const authCalls = { value: 0 };
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
    const run = yield* runStatus({
      services,
      members: [
        { id: "database-id", activation: "eager" },
        { id: "rest-id", activation: "lazy" },
        { id: "auth-id", activation: "lazy" },
      ],
      reachable: true,
    });
    yield* run.effect;
    const text = run.out.stdoutText;
    expect(text).toMatch(/^Stack status-stack · unhealthy · native · /u);
    expect(text).toMatch(/Project URL │ http:\/\/127\.0\.0\.1:54321 +│/u);
    expect(text).toContain("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(text).toMatch(/Publishable │ saved-publishable-key +│/u);
    expect(text).toMatch(/database +│ running · healthy · eager +│/u);
    expect(text).toMatch(/rest +│ sleeping · starts on first request +│/u);
    expect(text).toMatch(/auth +│ unhealthy · lazy +│/u);
    expect(text).toContain("Project configuration matches the saved composition members.");
    expect(text).not.toContain("database-id");
    expect(text).not.toContain(stackId);
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

it.live("reports the planned differences of composition members as drift", () =>
  Effect.gen(function* () {
    const drifted = (outputFormat: StatusOutputFormat) =>
      runStatus({
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
        members: [{ id: "database-id", activation: "eager" }],
        planned: [
          {
            id: "database-id",
            service: "database",
            member: true,
            change: "incompatible",
            paths: ["endpoints.sql.port"],
          },
          {
            id: "standalone-rest",
            service: "rest",
            member: false,
            change: "changed",
            paths: ["config.maxRows"],
          },
        ],
        config: "explicit",
        reachable: false,
        outputFormat,
      });
    const json = yield* drifted("json");
    yield* json.effect;
    expect(json.out.messages.find((message) => message.type === "success")?.data).toMatchObject({
      config_drift: { status: "changed", paths: ["services.database.endpoints.sql.port"] },
    });
    const text = yield* drifted("text");
    yield* text.effect;
    expect(text.out.stdoutText).toContain(
      "1 configured service value differs from the saved stack.\n  services.database.endpoints.sql.port\nRun supabase stack stop, then supabase stack start to apply the changes.\n",
    );
  }),
);

it.live(
  "reports the gateway-served MCP endpoint at the API URL, with no synthetic endpoint entry",
  () =>
    Effect.gen(function* () {
      const services = [
        makeService({
          id: "database-id",
          creation: database,
          statusCalls: { value: 0 },
          observation: makeObservation("database-id", database, {
            lifecycle: "running",
            health: "healthy",
            wakeEnabled: false,
            endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
          }),
        }),
        makeService({
          id: "auth-id",
          creation: auth,
          statusCalls: { value: 0 },
          observation: makeObservation("auth-id", auth, {
            endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
          }),
        }),
        makeService({
          id: "studio-id",
          creation: studio,
          statusCalls: { value: 0 },
          observation: makeObservation("studio-id", studio, {
            endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54323 }],
          }),
        }),
      ];
      const report = yield* runStatus({ services, reachable: true, outputFormat: "json" });
      yield* report.effect;
      const result = report.out.messages.find((message) => message.type === "success")?.data as {
        endpoints: Readonly<Record<string, unknown>>;
        env: Readonly<Record<string, string>>;
      };
      expect(result).toMatchObject({
        endpoints: { "studio.http": { url: "http://127.0.0.1:54323" } },
        env: { MCP_URL: "http://127.0.0.1:54321/mcp" },
      });
      expect(result.endpoints).not.toHaveProperty("studio.mcp");
      const env = yield* runStatus({ services, reachable: true, flags: flags({ env: true }) });
      yield* env.effect;
      expect(env.out.stdoutText).toContain("MCP_URL='http://127.0.0.1:54321/mcp'");
      expect(env.out.stdoutText).toContain("STUDIO_URL='http://127.0.0.1:54323'");
      expect(env.out.stdoutText).toContain("API_URL='http://127.0.0.1:54321'");
    }),
);

it.live("omits MCP_URL when no member exposes the shared API listener", () =>
  Effect.gen(function* () {
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls: { value: 0 },
        observation: makeObservation("database-id", database, {
          lifecycle: "running",
          health: "healthy",
          wakeEnabled: false,
          endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
        }),
      }),
      makeService({
        id: "studio-id",
        creation: studio,
        statusCalls: { value: 0 },
        observation: makeObservation("studio-id", studio, {
          endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54323 }],
        }),
      }),
    ];
    const report = yield* runStatus({ services, reachable: true, outputFormat: "json" });
    yield* report.effect;
    const result = report.out.messages.find((message) => message.type === "success")?.data as {
      env: Readonly<Record<string, string>>;
    };
    expect(result.env).not.toHaveProperty("MCP_URL");
  }),
);

it.live("omits MCP_URL when Studio is not a composition member", () =>
  Effect.gen(function* () {
    const services = [
      makeService({
        id: "database-id",
        creation: database,
        statusCalls: { value: 0 },
        observation: makeObservation("database-id", database, {
          lifecycle: "running",
          health: "healthy",
          wakeEnabled: false,
          endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
        }),
      }),
      makeService({
        id: "auth-id",
        creation: auth,
        statusCalls: { value: 0 },
        observation: makeObservation("auth-id", auth, {
          endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
        }),
      }),
    ];
    const report = yield* runStatus({ services, reachable: true, outputFormat: "json" });
    yield* report.effect;
    const result = report.out.messages.find((message) => message.type === "success")?.data as {
      env: Readonly<Record<string, string>>;
    };
    expect(result.env).not.toHaveProperty("MCP_URL");
  }),
);

const storageServices = (creation: ServiceCreation) => {
  return [
    makeService({
      id: "database-id",
      creation: database,
      statusCalls: { value: 0 },
      observation: makeObservation("database-id", database, {
        lifecycle: "running",
        health: "healthy",
        endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
      }),
    }),
    makeService({
      id: "storage-id",
      creation,
      statusCalls: { value: 0 },
      observation: makeObservation("storage-id", creation, {
        lifecycle: "running",
        health: "healthy",
        endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
      }),
    }),
  ];
};

it.live("reports the Storage S3 endpoint and access keys through the gateway", () =>
  Effect.gen(function* () {
    const text = yield* runStatus({ services: storageServices(storage(true)), reachable: true });
    yield* text.effect;
    expect(text.out.stdoutText).toMatch(/URL +│ http:\/\/127\.0\.0\.1:54321\/storage\/v1\/s3 +│/u);
    expect(text.out.stdoutText).toMatch(/Access Key +│ local-access-key +│/u);
    expect(text.out.stdoutText).toMatch(/Secret Key +│ local-secret-key +│/u);
    expect(text.out.stdoutText).toMatch(/Region +│ local +│/u);
    const env = yield* runStatus({
      services: storageServices(storage(true)),
      reachable: true,
      flags: flags({ env: true }),
    });
    yield* env.effect;
    expect(env.out.stdoutText).toContain("STORAGE_S3_URL='http://127.0.0.1:54321/storage/v1/s3'");
    expect(env.out.stdoutText).toContain("S3_PROTOCOL_ACCESS_KEY_ID='local-access-key'");
    expect(env.out.stdoutText).toContain("S3_PROTOCOL_ACCESS_KEY_SECRET='local-secret-key'");
    expect(env.out.stdoutText).toContain("S3_PROTOCOL_REGION='local'");
  }),
);

it.live("omits Storage S3 details when the S3 protocol is disabled", () =>
  Effect.gen(function* () {
    const text = yield* runStatus({ services: storageServices(storage(false)), reachable: true });
    yield* text.effect;
    expect(text.out.stdoutText).toMatch(/Project URL +│ http:\/\/127\.0\.0\.1:54321 +│/u);
    expect(text.out.stdoutText).not.toContain("Storage (S3)");
    const env = yield* runStatus({
      services: storageServices(storage(false)),
      reachable: true,
      flags: flags({ env: true }),
    });
    yield* env.effect;
    expect(env.out.stdoutText).toContain("API_URL='http://127.0.0.1:54321'");
    expect(env.out.stdoutText).not.toContain("S3_PROTOCOL_");
    expect(env.out.stdoutText).not.toContain("STORAGE_S3_URL");
  }),
);

it.live("omits Storage S3 details for a Storage member saved without S3 keys", () =>
  Effect.gen(function* () {
    const env = yield* runStatus({
      services: storageServices({
        service: "storage",
        config: { filePath: "/project/supabase/.temp/stack-uploads", jwtSecret },
        endpoints: { http: { port: 54321 } },
      }),
      reachable: true,
      flags: flags({ env: true }),
    });
    yield* env.effect;
    expect(env.out.stdoutText).toContain("API_URL='http://127.0.0.1:54321'");
    expect(env.out.stdoutText).not.toContain("S3_PROTOCOL_");
    expect(env.out.stdoutText).not.toContain("STORAGE_S3_URL");
  }),
);

for (const { functionsMember, status } of [
  { functionsMember: false, status: "unchanged" },
  { functionsMember: true, status: "unavailable" },
] as const)
  it.live(
    `reports ${status} drift for a multiline Functions dotenv when Functions is ${functionsMember ? "" : "not "}a member`,
    () =>
      Effect.gen(function* () {
        const services = [
          makeService({ id: "database-id", creation: database, statusCalls: { value: 0 } }),
          makeService({ id: "functions-id", creation: functions, statusCalls: { value: 0 } }),
        ];
        const run = yield* runStatus({
          services,
          members: [
            { id: "database-id", activation: "eager" },
            ...(functionsMember ? [{ id: "functions-id", activation: "eager" as const }] : []),
          ],
          config: "multiline-functions-env",
          reachable: false,
          outputFormat: "json",
        });
        yield* run.effect;
        const result = run.out.messages.find((message) => message.type === "success")?.data;
        expect(result).toMatchObject({ config_drift: { status } });
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
    expect(run.out.stdoutText).toMatch(/^Stack status-stack · unavailable · /u);
    expect(run.out.stdoutText).toContain("The stack owner is not running.");
    expect(run.out.stdoutText).toMatch(/database +│ unavailable · lazy +│/u);
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

it.live("exports saved credentials only for a running database", () =>
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
      "DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'",
    );
    expect(run.out.stdoutText).toContain("API_URL='http://127.0.0.1:54321'");
    expect(run.out.stdoutText).toContain("ANON_KEY='saved-anon-token'");
    expect(run.out.stdoutText).toContain("SERVICE_ROLE_KEY='saved-service-token'");
    expect(run.out.stdoutText).toContain("PUBLISHABLE_KEY='saved-publishable-key'");
    expect(run.out.stdoutText).toContain("SECRET_KEY='saved-secret-key'");
  }),
);

it.live("derives DB_URL using the postgres role and a non-default saved password", () =>
  Effect.gen(function* () {
    const password = "p@ss w/ord!";
    const customDatabase: ServiceCreation = {
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make(password),
        jwtSecret: Redacted.make(jwtSecret),
        jwtExpiry: 3600,
      },
      endpoints: { sql: { port: 54322 } },
    };
    const services = [
      makeService({
        id: "database-id",
        creation: customDatabase,
        statusCalls: { value: 0 },
        observation: makeObservation("database-id", customDatabase, {
          lifecycle: "running",
          health: "healthy",
          endpoints: [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54322 }],
        }),
      }),
    ];
    const run = yield* runStatus({ services, reachable: true, flags: flags({ env: true }) });
    yield* run.effect;
    expect(run.out.stdoutText).toContain(
      `DB_URL='postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:54322/postgres'`,
    );
  }),
);

it.live("the status JSON env map equals the status --env export for the same stack", () =>
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
    const report = yield* runStatus({ services, reachable: true, outputFormat: "json" });
    yield* report.effect;
    const result = report.out.messages.find((message) => message.type === "success")?.data as {
      env: Readonly<Record<string, string>>;
    };
    const exported = yield* runStatus({
      services,
      reachable: true,
      outputFormat: "json",
      flags: flags({ env: true }),
    });
    yield* exported.effect;
    const exportedValues = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(exported.out.stdoutText);
    expect(result.env).toEqual(exportedValues);
    expect(result.env.REST_URL).toBe("http://127.0.0.1:54321/rest/v1");
  }),
);

it.live("status JSON env degrades to what's available when credentials are unreachable", () =>
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
      }),
    ];
    const run = yield* runStatus({
      services,
      reachable: true,
      outputFormat: "json",
      credentialsUnavailable: true,
    });
    yield* run.effect;
    const result = run.out.messages.find((message) => message.type === "success")?.data as {
      env: Readonly<Record<string, string>>;
    };
    expect(result.env).not.toHaveProperty("PUBLISHABLE_KEY");
    expect(result.env.DB_URL).toContain("127.0.0.1:54322");
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
