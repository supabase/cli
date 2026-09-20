import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { PgClient } from "@effect/sql-pg";
import { create as createStack } from "@supabase/stack/effect";
import { tmpdir } from "node:os";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const COMMAND_TIMEOUT_MS = 8 * 60_000;
const TEST_TIMEOUT_MS = COMMAND_TIMEOUT_MS + 2 * 60_000;
const JWT_SECRET = "db-reset-stack-e2e-jwt-secret-with-32-chars";
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const projectConfig = `project_id = "db-reset-stack-e2e"

[experimental]
stack = true

[api]
enabled = true

[db]
major_version = 17

[db.seed]
enabled = true
sql_paths = ["seed.sql"]

[auth]
enabled = true

[realtime]
enabled = false

[storage]
enabled = false

[edge_runtime]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[db.pooler]
enabled = false

[local_smtp]
enabled = false
`;

class DbResetStackE2eError extends Data.TaggedError("DbResetStackE2eError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const writeFixture = Effect.fn("DbResetStackE2e.writeFixture")(function* (
  root: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const migrations = path.join(root, "supabase", "migrations");
  yield* fs.makeDirectory(migrations, { recursive: true });
  yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), projectConfig);
  yield* fs.writeFileString(
    path.join(migrations, "20260920000000_reset_story.sql"),
    `create table public.reset_story_marker (value text primary key);
create table public.reset_story_user_link (
  user_id uuid references auth.users(id),
  value text not null
);
`,
  );
  yield* fs.writeFileString(
    path.join(root, "supabase", "seed.sql"),
    "insert into public.reset_story_marker(value) values ('seeded');\n",
  );
});

const query = Effect.fn("DbResetStackE2e.query")(function* (url: string, sql: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(PgClient.layer({ url: Redacted.make(url) }));
      return yield* Context.get(services, PgClient.PgClient).unsafe(sql);
    }),
  ).pipe(
    Effect.mapError(
      (cause) => new DbResetStackE2eError({ message: `query failed: ${sql}`, cause }),
    ),
  );
});

const responseStatus = Effect.fn("DbResetStackE2e.responseStatus")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .get(url)
    .pipe(
      Effect.mapError(
        (cause) => new DbResetStackE2eError({ message: `request failed: ${url}`, cause }),
      ),
    );
  yield* response.arrayBuffer;
  return response.status;
});

const composeStack = Effect.fn("DbResetStackE2e.composeStack")(function* (
  root: string,
  home: string,
  runtime: "native" | "docker",
) {
  const stack = yield* createStack({
    projectRoot: root,
    stateRoot: `${home}/stacks`,
    cacheRoot: `${home}/cache/stack`,
    runtime,
  });
  yield* Effect.addFinalizer(() =>
    stack.destroy.pipe(
      Effect.catch((cause) =>
        Effect.die(new DbResetStackE2eError({ message: "stack cleanup failed", cause })),
      ),
    ),
  );
  yield* stack.composition.supabase([
    {
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("postgres"),
        jwtSecret: Redacted.make(JWT_SECRET),
        jwtExpiry: 3600,
      },
      endpoints: { sql: { port: "auto" } },
    },
    {
      service: "rest",
      config: {
        databaseUrl: "postgresql://placeholder",
        jwtSecret: JWT_SECRET,
      },
      endpoints: { http: { port: "auto" } },
    },
    {
      service: "auth",
      config: {
        databaseUrl: "postgresql://placeholder",
        jwtSecret: JWT_SECRET,
      },
      endpoints: { http: { port: "auto" } },
    },
  ]);
  yield* stack.composition.start;
  return stack;
});

describe("supabase db reset (stack e2e)", () => {
  for (const runtime of ["native", "docker"] as const) {
    if (runtime === "native" && !nativeSupported) continue;

    it.live(
      `resets the same ${runtime} database instance and resumes its lazy composition`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: `db-reset-${runtime}-` });
          const home = yield* fs.makeTempDirectoryScoped({ prefix: `db-reset-home-${runtime}-` });
          yield* writeFixture(root, fs, path);
          yield* fs.makeDirectory(path.join(home, "cache"), { recursive: true });
          yield* fs.makeDirectory(path.join(tmpdir(), "supabase-stack-artifacts"), {
            recursive: true,
          });
          yield* fs.symlink(
            path.join(tmpdir(), "supabase-stack-artifacts"),
            path.join(home, "cache", "stack"),
          );

          const stack = yield* composeStack(root, home, runtime);

          const beforeComposition = yield* stack.composition.describe;
          const beforeServices = yield* stack.services.list;
          const database = beforeServices.find((service) => service.service === "database");
          const rest = beforeServices.find((service) => service.service === "rest");
          const auth = beforeServices.find((service) => service.service === "auth");
          if (
            database?.service !== "database" ||
            rest?.service !== "rest" ||
            auth?.service !== "auth"
          )
            return yield* Effect.die("database, REST, and Auth instances are missing");
          const beforeCredentials = yield* database.credentials();
          const databaseUrl = beforeCredentials.databaseUrl;
          if (databaseUrl === undefined) return yield* Effect.die("database URL is missing");
          const beforeStatus = yield* database.status;
          const beforeSqlPort = beforeStatus.endpoints.find(({ name }) => name === "sql")?.port;
          if (beforeSqlPort === undefined) return yield* Effect.die("database SQL port is missing");

          yield* query(
            databaseUrl,
            `create table public.reset_story_stale (value text);
             insert into public.reset_story_stale values ('before-reset');
             create role reset_story_stale_role login password 'stale-password';`,
          );
          yield* query(databaseUrl, "create database reset_story_stale_database;");

          const reset = yield* runSupabaseEffect(["db", "reset", "--local"], {
            cwd: root,
            home,
            env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
            exitTimeoutMs: COMMAND_TIMEOUT_MS,
          });
          expect(reset.exitCode, `stdout:\n${reset.stdout}\nstderr:\n${reset.stderr}`).toBe(0);

          const afterComposition = yield* stack.composition.describe;
          expect(afterComposition).toEqual(beforeComposition);
          const afterServices = yield* stack.services.list;
          const afterDatabase = afterServices.find((service) => service.service === "database");
          const afterRest = afterServices.find((service) => service.service === "rest");
          const afterAuth = afterServices.find((service) => service.service === "auth");
          if (
            afterDatabase?.service !== "database" ||
            afterRest?.service !== "rest" ||
            afterAuth?.service !== "auth"
          )
            return yield* Effect.die("database, REST, and Auth instances disappeared");
          expect(afterDatabase.id).toBe(database.id);
          expect((yield* afterDatabase.credentials()).databaseUrl).toBe(databaseUrl);
          expect(
            (yield* afterDatabase.status).endpoints.find(({ name }) => name === "sql")?.port,
          ).toBe(beforeSqlPort);

          const rows = yield* query(
            databaseUrl,
            `select
               (select count(*) from supabase_migrations.schema_migrations where version = '20260920000000') as migration_count,
               (select count(*) from public.reset_story_marker where value = 'seeded') as seed_count,
               to_regclass('public.reset_story_stale') as stale_table,
               to_regclass('auth.users') is not null as auth_users,
               exists (select 1 from pg_roles where rolname = 'reset_story_stale_role') as stale_role,
               exists (select 1 from pg_database where datname = 'reset_story_stale_database') as stale_database;`,
          );
          expect(rows).toEqual([
            {
              migration_count: "1",
              seed_count: "1",
              stale_table: null,
              auth_users: true,
              stale_role: false,
              stale_database: false,
            },
          ]);

          const restStatus = yield* afterRest.status;
          expect(restStatus.lifecycle).toBe("stopped");
          expect(restStatus.wakeEnabled).toBe(true);
          const restCredentials = yield* afterRest.credentials();
          const restUrl = restCredentials.url;
          if (restUrl === undefined) return yield* Effect.die("REST URL is missing");
          expect(yield* responseStatus(restUrl)).toBe(200);
        }).pipe(Effect.provide([BunServices.layer, FetchHttpClient.layer])),
      { timeout: TEST_TIMEOUT_MS },
    );
  }
});
