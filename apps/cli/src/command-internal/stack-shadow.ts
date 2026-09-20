import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import type { DatabaseInstance, Stack } from "@supabase/stack/effect";
import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { StackApi } from "./stack-api.ts";
import { StackCatalogSetup } from "./stack-catalog-setup.ts";
import { stackProjectRuntime } from "./stack-local-database.ts";
import { defaultStackRuntime } from "./stack-runtime.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { toPostgresURL } from "./postgres-url.ts";
import {
  connectShadowDatabase,
  ShadowDbError,
  type ShadowSetupInput,
} from "./db-bootstrap/shadow-database.ts";
import type { SetupDatabaseOptions } from "./db-bootstrap/db-setup.ts";
import { listLocalMigrationPaths } from "./migration-history.ts";
import { applyMigrations } from "./migration-apply.ts";

type Runtime = "native" | "docker" | "podman";

export interface StackShadowAcquiredHandle {
  readonly stack: Stack;
  readonly database: DatabaseInstance;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly runtime: Runtime;
  readonly version: string;
}

interface ShadowOptions {
  readonly port?: number;
  readonly runtime?: Runtime;
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
}

const shadowError = (cause: { readonly message: string }) =>
  cause instanceof ShadowDbError
    ? cause
    : new ShadowDbError({ message: cause.message, reason: "database" });

const acquireNamespace = Effect.fn("StackShadow.acquireNamespace")(function* (opts: ShadowOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const runtime = opts.runtime ?? (yield* stackProjectRuntime) ?? defaultStackRuntime(runtimeInfo);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-shadow-" });
  const stack = yield* api.create({
    projectRoot: root,
    stateRoot: path.join(settings.supabaseHome, "stacks"),
    cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    runtime,
  });
  return { stack, runtime };
});

const initialize = Effect.fn("StackShadow.initialize")(function* (
  stack: Stack,
  runtime: Runtime,
  input: ShadowSetupInput<unknown>,
  opts: ShadowOptions,
) {
  const settings = yield* Schema.decodeEffect(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  )(
    Object.fromEntries(
      Object.entries(input.db.settings ?? {}).filter(([, value]) => value !== undefined),
    ),
  ).pipe(Effect.mapError(shadowError));
  const database = yield* stack.services.create({
    service: "database",
    config: {
      version: String(input.setup.majorVersion),
      databasePassword: Redacted.make(input.password),
      jwtSecret: Redacted.make(input.jwtSecret),
      jwtExpiry: input.jwtExpiry,
      settings,
    },
    endpoints: { sql: { port: opts.port ?? "auto" } },
  });
  yield* database.start;
  yield* database.ready;
  const catalog = yield* StackCatalogSetup;
  yield* catalog.apply({
    target: {
      stack,
      database,
      databaseServices: [
        ...(input.setup.authEnabledForSetup ? ["auth" as const] : []),
        ...(input.setup.storageEnabledForSetup ? ["storage" as const] : []),
        ...(input.setup.realtimeEnabledForSetup ? ["realtime" as const] : []),
      ],
      jwtSecret: input.jwtSecret,
    },
    overlay: {
      ...(opts.webhooks === undefined ? {} : { webhooks: opts.webhooks }),
      webhooksEnabled: input.setup.webhooksEnabled,
      apiAutoExposeNewTables: input.setup.apiAutoExposeNewTables,
      vault: input.setup.vault,
      workdir: input.workdir,
      announceRoles: false,
    },
  });
  const credentials = yield* database.credentials({ from: "host" });
  const credentialUrl = credentials.databaseUrl;
  const credentialsConn =
    credentialUrl === undefined ? undefined : parseConnectionString(credentialUrl);
  if (credentialsConn === undefined || credentialUrl === undefined)
    return yield* new ShadowDbError({
      message: "Shadow database URL is unavailable",
      reason: "connect",
    });
  const url = toPostgresURL({ ...credentialsConn, user: "postgres" });
  const conn = credentialsConn;
  return {
    stack,
    database,
    url,
    host: conn.host,
    port: conn.port,
    runtime,
    version: String(input.setup.majorVersion),
  } satisfies StackShadowAcquiredHandle;
});

/** Acquires a fresh shadow for callers whose enclosing scope owns its lifetime. */
export const stackAcquireShadowDatabase = Effect.fn("StackShadow.acquire")(function* (
  input: ShadowSetupInput<unknown>,
  opts: ShadowOptions = {},
) {
  const output = yield* Output;
  const namespace = yield* Effect.acquireRelease(acquireNamespace(opts), ({ stack }) =>
    stack.destroy.pipe(
      Effect.catch((cause) =>
        output.raw(
          `Failed to destroy shadow stack ${stack.id}: ${cause.message}. Run supabase stack destroy --stack-id ${stack.id} to remove it.\n`,
          "stderr",
        ),
      ),
    ),
  );
  return yield* initialize(namespace.stack, namespace.runtime, input, opts);
}, Effect.mapError(shadowError));

/** Runs a command against a fresh shadow, then destroys its owned namespace. */
export const stackWithShadowDatabase = Effect.fn("StackShadow.withDatabase")(
  <A, E, R>(
    input: ShadowSetupInput<unknown>,
    use: (handle: StackShadowAcquiredHandle) => Effect.Effect<A, E, R>,
    opts: ShadowOptions = {},
  ) => Effect.scoped(stackAcquireShadowDatabase(input, opts).pipe(Effect.flatMap(use))),
);

export const stackMigrateShadow = Effect.fn("StackShadow.migrate")(function* (
  handle: StackShadowAcquiredHandle,
  input: ShadowSetupInput<unknown>,
) {
  const migrationsDir = input.path.join(input.workdir, "supabase", "migrations");
  const pending = yield* listLocalMigrationPaths(input.fs, input.path, migrationsDir).pipe(
    Effect.mapError((cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" })),
  );
  const conn = parseConnectionString(handle.url);
  if (conn === undefined)
    return yield* new ShadowDbError({ message: "Invalid shadow database URL", reason: "connect" });
  const session = yield* connectShadowDatabase(conn);
  yield* applyMigrations(
    session,
    input.fs,
    input.path,
    pending,
    (message) => new ShadowDbError({ message, reason: "database" }),
  ).pipe(
    Effect.catchTag("DbConnectError", (cause) =>
      Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
    ),
    Effect.mapError(shadowError),
  );
});

export const stackPrepareShadowSource = Effect.fn("StackShadow.prepareSource")(
  (handle: StackShadowAcquiredHandle, input: ShadowSetupInput<unknown>) =>
    Effect.scoped(stackMigrateShadow(handle, input)).pipe(
      Effect.as({ sourceUrl: handle.url, targetUrlOverride: undefined }),
    ),
);
