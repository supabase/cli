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
  Ref,
  Result,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { create, StackError, type Stack } from "@supabase/stack/effect";
import { postgres } from "@supabase/stack/commands";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import type { Command } from "@supabase/stack/commands";
import { ensureStackWebhookSchema } from "./db-bootstrap/db-setup.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection, type DbSession } from "./db-connection.service.ts";
import { dbConnectionLayer } from "./db-connection.sql-pg.layer.ts";
import { stackCatalogSetupLayer, StackCatalogSetup } from "./stack-catalog-setup.ts";
import { destroyTestStack } from "../../tests/helpers/stack-cleanup.ts";
import { stackArtifactCacheRoot } from "../../tests/helpers/stack-artifacts.ts";

const cacheRoot = stackArtifactCacheRoot;
const jwtSecret = "stack-catalog-setup-integration-secret";

describe("stack catalog setup", { timeout: 180_000 }, () => {
  for (const runtime of ["native", "docker"] as const) {
    it.live(
      `initializes service schemas without temporary services on a stopped ${runtime} composition`,
      () => {
        const buildOutput = mockOutput();
        const callOutput = mockOutput();
        return Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-catalog-${runtime}-` });
            yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
            yield* fs.writeFileString(
              `${root}/supabase/roles.sql`,
              "CREATE TABLE IF NOT EXISTS public.catalog_overlay(owner uuid REFERENCES auth.users(id), session_id uuid REFERENCES auth.sessions(id), upload_id text REFERENCES storage.s3_multipart_uploads(id), value text NOT NULL);\n",
            );
            const stack = yield* create({
              projectRoot: root,
              stateRoot: `${root}/state`,
              cacheRoot,
              runtime,
            });
            yield* Effect.acquireUseRelease(
              Effect.succeed(stack),
              (stack) =>
                Effect.gen(function* () {
                  const members = yield* stack.composition.supabase([
                    {
                      service: "database",
                      config: {
                        version: "17",
                        databasePassword: Redacted.make("postgres"),
                        jwtSecret: Redacted.make(jwtSecret),
                        jwtExpiry: 3600,
                      },
                      endpoints: { sql: { port: "auto" } },
                    },
                    {
                      service: "auth",
                      config: { jwtSecret },
                      endpoints: { http: { port: "auto" } },
                    },
                    {
                      service: "storage",
                      config: {
                        jwtSecret,
                        filePath: `${root}/unused-storage`,
                      },
                      endpoints: { http: { port: "auto" } },
                    },
                    {
                      service: "realtime",
                      config: { jwtSecret },
                      endpoints: { http: { port: "auto" }, rpc: { port: "auto" } },
                    },
                  ]);
                  const database = members.find((member) => member.service === "database");
                  if (database === undefined) return yield* Effect.die("database member missing");
                  yield* database.start;
                  yield* database.ready;
                  const runtimeCredentials = yield* database.credentials({ from: "runtime" });
                  const databaseUrl = runtimeCredentials.databaseUrl;
                  if (databaseUrl === undefined) return yield* Effect.die("database URL missing");

                  const setup = yield* Effect.service(StackCatalogSetup);
                  yield* setup
                    .apply({
                      target: {
                        stack,
                        database,
                        databaseServices: ["auth", "storage", "realtime"],
                      },
                      overlay: {
                        webhooks: "enabled",
                        webhooksEnabled: true,
                        apiAutoExposeNewTables: Option.none(),
                        vault: [],
                        workdir: root,
                        announceRoles: true,
                      },
                    })
                    .pipe(Effect.provide(callOutput.layer));
                  expect(callOutput.stderrText).toContain("Seeding globals from roles.sql...");
                  const rows: Array<string> = [];
                  const errors: Array<string> = [];
                  const query = yield* stack.commands.run(postgres.psql({ major: 17 }), {
                    args: ["--dbname", databaseUrl, "-At"],
                    stdin: Stream.make(
                      new TextEncoder().encode(
                        "select coalesce(to_regclass('auth.users')::text,'missing'), coalesce(to_regclass('auth.sessions')::text,'missing'), coalesce(to_regclass('storage.objects')::text,'missing'), coalesce(to_regclass('storage.s3_multipart_uploads')::text,'missing'), coalesce(to_regclass('realtime.messages')::text,'missing'), coalesce(to_regclass('realtime.subscription')::text,'missing'), coalesce(to_regclass('public.catalog_overlay')::text,'missing'), coalesce(to_regprocedure('supabase_functions.http_request()')::text,'missing');",
                      ),
                    ),
                    stdout: (bytes) =>
                      Effect.sync(() => rows.push(new TextDecoder().decode(bytes))),
                    stderr: (bytes) =>
                      Effect.sync(() => errors.push(new TextDecoder().decode(bytes))),
                  });
                  expect(query.exitCode, errors.join("")).toBe(0);
                  expect(rows.join("").trim()).toBe(
                    "users|sessions|storage.objects|storage.s3_multipart_uploads|realtime.messages|realtime.subscription|catalog_overlay|supabase_functions.http_request()",
                  );
                  // pg_net queues webhook requests under the image's function policy.
                  const pgNet: Array<string> = [];
                  const pgNetQuery = yield* stack.commands.run(postgres.psql({ major: 17 }), {
                    args: ["--dbname", databaseUrl, "-Atq", "-v", "ON_ERROR_STOP=1"],
                    stdin: Stream.make(
                      new TextEncoder().encode(
                        "begin; create table public.catalog_hook(id int); create trigger catalog_hook after insert on public.catalog_hook for each row execute function supabase_functions.http_request('http://127.0.0.1:9', 'POST', '{}', '{}', '1000'); insert into public.catalog_hook values (1); select (select count(*) from net.http_request_queue) || ';' || string_agg(format('%s:secdef=%s:search_path=%s', proname, prosecdef::text, (exists (select from unnest(proconfig) as setting where setting like 'search_path=%'))::text), ',' order by proname) from pg_proc where pronamespace = 'net'::regnamespace and proname in ('http_get', 'http_post'); rollback;",
                      ),
                    ),
                    stdout: (bytes) =>
                      Effect.sync(() => pgNet.push(new TextDecoder().decode(bytes))),
                    stderr: (bytes) =>
                      Effect.sync(() => errors.push(new TextDecoder().decode(bytes))),
                  });
                  expect(pgNetQuery.exitCode, errors.join("")).toBe(0);
                  expect(pgNet.join("").trim()).toBe(
                    "1;http_get:secdef=false:search_path=false,http_post:secdef=false:search_path=false",
                  );

                  // The main database already has supabase_functions, so race on a fresh one.
                  const hostDatabaseUrl = (yield* database.credentials({ from: "host" }))
                    .databaseUrl;
                  if (hostDatabaseUrl === undefined)
                    return yield* Effect.die("host database URL missing");
                  const host = parseConnectionString(hostDatabaseUrl);
                  if (host === undefined) return yield* Effect.die("host database URL unparseable");
                  yield* Effect.scoped(
                    Effect.gen(function* () {
                      const path = yield* Path.Path;
                      const db = yield* DbConnection;
                      const admin = yield* db.connect(host, {
                        isLocal: true,
                        dnsResolver: "native",
                      });
                      yield* admin.exec("create database webhook_schema_race");
                      const race = { ...host, database: "webhook_schema_race" };
                      const [first, second] = yield* Effect.all([
                        db.connect(race, { isLocal: true, dnsResolver: "native" }),
                        db.connect(race, { isLocal: true, dnsResolver: "native" }),
                      ]);
                      const missing = first.query(
                        "select to_regnamespace('supabase_functions') is null as missing",
                      );
                      expect(yield* missing).toEqual([{ missing: true }]);
                      const ensure = Effect.fn(function* (session: DbSession) {
                        const sqlPath = yield* fs.makeTempDirectoryScoped({
                          prefix: "webhook-race-",
                        });
                        yield* ensureStackWebhookSchema(session, fs, path, sqlPath);
                      });
                      yield* Effect.all([ensure(first), ensure(second)], {
                        concurrency: "unbounded",
                      });
                      expect(yield* missing).toEqual([{ missing: false }]);
                    }),
                  );

                  const credentials = yield* stack.credentials.get;
                  if (credentials === undefined)
                    return yield* Effect.die("stack credentials missing");
                  const tenantJwks: Array<string> = [];
                  const tenantJwksQuery = yield* stack.commands.run(postgres.psql({ major: 17 }), {
                    args: ["--dbname", databaseUrl, "-At"],
                    stdin: Stream.make(
                      new TextEncoder().encode(
                        "SELECT jwt_jwks::text FROM _realtime.tenants WHERE external_id = 'realtime-dev';",
                      ),
                    ),
                    stdout: (bytes) =>
                      Effect.sync(() => tenantJwks.push(new TextDecoder().decode(bytes))),
                    stderr: (bytes) =>
                      Effect.sync(() => errors.push(new TextDecoder().decode(bytes))),
                  });
                  expect(tenantJwksQuery.exitCode, errors.join("")).toBe(0);
                  expect(JSON.parse(tenantJwks.join("").trim())).toEqual(
                    JSON.parse(credentials.jwks),
                  );

                  const realtime = members.find((member) => member.service === "realtime");
                  if (realtime === undefined) return yield* Effect.die("realtime member missing");
                  yield* realtime.start;
                  yield* realtime.ready;
                  yield* realtime.stop;

                  const listed = yield* stack.services.list;
                  expect(listed.map((instance) => instance.id).sort()).toEqual(
                    members.map((instance) => instance.id).sort(),
                  );
                  for (const instance of listed) {
                    if (instance.service !== "database")
                      expect((yield* instance.status).lifecycle).toBe("stopped");
                  }

                  const runControlledSetup = Effect.fn("StackCatalogSetup.integration.controlled")(
                    function* (mode: "failure" | "interruption") {
                      const storageReady = yield* Deferred.make<void>();
                      const authReady = yield* Deferred.make<void>();
                      const releaseStorage = yield* Deferred.make<void>();
                      const releaseAuth = yield* Deferred.make<void>();
                      const temporaryDirectory = yield* Ref.make<string | undefined>(undefined);
                      const controlledStack: Stack = {
                        ...stack,
                        commands: {
                          ...stack.commands,
                          run: (invocation: Command) => {
                            if (!("type" in invocation))
                              return Effect.die("postgres command is not used in this fixture");
                            if (invocation.type === "storage.initialize")
                              return Ref.set(temporaryDirectory, invocation.filePath).pipe(
                                Effect.andThen(Deferred.succeed(storageReady, undefined)),
                                Effect.andThen(Deferred.await(releaseStorage)),
                                Effect.as({ jobId: "controlled-storage", exitCode: 0 as const }),
                              );
                            if (mode === "interruption")
                              return Deferred.succeed(authReady, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseAuth)),
                                Effect.as({ jobId: "controlled-auth", exitCode: 0 as const }),
                              );
                            return Deferred.await(storageReady).pipe(
                              Effect.andThen(
                                Effect.fail(
                                  new StackError({
                                    operation: "initialize",
                                    message: "controlled Auth initialization failure",
                                  }),
                                ),
                              ),
                            );
                          },
                        },
                      };
                      const beforeOutput = callOutput.stderrText;
                      const run = setup
                        .apply({
                          target: {
                            stack: controlledStack,
                            database,
                            databaseServices: ["auth", "storage"],
                          },
                          overlay: {
                            webhooks: "disabled",
                            webhooksEnabled: false,
                            apiAutoExposeNewTables: Option.none(),
                            vault: [],
                            workdir: root,
                            announceRoles: true,
                          },
                        })
                        .pipe(Effect.provide(callOutput.layer));

                      if (mode === "failure") {
                        const result = yield* Effect.result(run);
                        expect(Result.isFailure(result)).toBe(true);
                        if (Result.isFailure(result))
                          expect(result.failure.message).toContain(
                            "controlled Auth initialization failure",
                          );
                      } else {
                        const fiber = yield* Effect.forkScoped(run);
                        yield* Deferred.await(storageReady);
                        yield* Deferred.await(authReady);
                        yield* Fiber.interrupt(fiber);
                        const exit = yield* Fiber.await(fiber);
                        expect(Exit.hasInterrupts(exit)).toBe(true);
                      }

                      expect(callOutput.stderrText).toBe(beforeOutput);
                      const temporaryPath = yield* Ref.get(temporaryDirectory);
                      if (temporaryPath === undefined)
                        return yield* Effect.die("temporary storage directory was not created");
                      expect(yield* fs.exists(temporaryPath)).toBe(false);
                      const current = yield* stack.services.list;
                      expect(current.map((instance) => instance.id).sort()).toEqual(
                        members.map((instance) => instance.id).sort(),
                      );
                    },
                  );

                  yield* runControlledSetup("failure");
                  yield* runControlledSetup("interruption");
                }),
              destroyTestStack,
            );
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              BunServices.layer,
              FetchHttpClient.layer,
              buildOutput.layer,
              stackCatalogSetupLayer,
              dbConnectionLayer,
            ),
          ),
        );
      },
    );
  }
});
