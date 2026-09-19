import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Redacted } from "effect";
import { tmpdir } from "node:os";
import {
  create,
  discover,
  open,
  postgres,
  type DatabaseInstance,
  type ServiceInstance,
} from "./effect.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

it.live("registers and discovers saved definitions without inventing live observations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const entries = yield* discover(options);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.definition.id).toBe(stack.id);
    expect(entries[0]?.host).toBeUndefined();
    expect(entries[0]?.definition.instances).toEqual([]);
    expect(yield* stack.services.list).toEqual([]);
    expect(yield* stack.composition.describe).toEqual({ members: [], dependencies: [] });
    expect((yield* discover(options))[0]?.host).toBeUndefined();
    const duplicate = yield* Effect.flip(create(options));
    expect(duplicate.message).toContain("already exists");
    const reopened = yield* open({ ...options, id: stack.id });
    expect(reopened.id).toBe(stack.id);
    const missing = yield* Effect.flip(open({ ...options, id: "missing" }));
    expect(missing.message).toContain("does not exist");

    const database = stack.services.create({
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("test"),
        jwtSecret: Redacted.make("test"),
        jwtExpiry: 3600,
      },
    });
    const rest = stack.services.create({
      service: "rest",
      config: { databaseUrl: "postgres://external" },
    });
    expectTypeOf<Effect.Success<typeof database>>().toEqualTypeOf<DatabaseInstance>();
    expectTypeOf<Effect.Success<typeof rest>>().toEqualTypeOf<ServiceInstance<"rest">>();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

const resetDataStory = (runtime: "native" | "docker") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-reset-data-${runtime}-` });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
      runtime,
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    yield* Effect.acquireUseRelease(
      Effect.succeed(stack),
      (current) =>
        Effect.gen(function* () {
          const target = yield* current.services.create({
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("reset-target-password"),
              jwtSecret: Redacted.make("reset-target-jwt-secret"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          });
          const sibling = yield* current.services.create({
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("reset-sibling-password"),
              jwtSecret: Redacted.make("reset-sibling-jwt-secret"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          });
          const composition = {
            members: [
              { id: target.id, activation: "lazy" as const },
              { id: sibling.id, activation: "eager" as const },
            ],
            dependencies: [],
          };
          yield* current.composition.configure(composition);

          yield* current.composition.start;
          const armed = yield* target.status;
          expect(armed.lifecycle).toBe("stopped");
          expect(armed.wakeEnabled).toBe(true);
          const armedReset = yield* Effect.flip(target.resetData);
          expect(armedReset.message).toContain("must be stopped with wake disabled");
          yield* current.composition.stop;
          expect((yield* target.status).wakeEnabled).toBe(false);

          yield* target.start;
          yield* target.ready;
          yield* sibling.start;
          yield* sibling.ready;
          const targetCredentials = yield* target.credentials({ from: "runtime" });
          const siblingCredentials = yield* sibling.credentials({ from: "runtime" });
          const targetUrl = targetCredentials.databaseUrl;
          const siblingUrl = siblingCredentials.databaseUrl;
          if (targetUrl === undefined || siblingUrl === undefined)
            return yield* Effect.die("database credentials missing");

          const runSql = Effect.fn("ResetData.runSql")((
            client: typeof current,
            url: string,
            sql: string,
          ) => {
            const stdout: Array<string> = [];
            const stderr: Array<string> = [];
            return client.tools
              .run(postgres.psql({ major: 17 }), {
                args: ["--dbname", url, "-Atc", sql],
                stdout: (bytes) => Effect.sync(() => stdout.push(new TextDecoder().decode(bytes))),
                stderr: (bytes) => Effect.sync(() => stderr.push(new TextDecoder().decode(bytes))),
              })
              .pipe(
                Effect.map((result) => ({
                  ...result,
                  stdout: stdout.join(""),
                  stderr: stderr.join(""),
                })),
              );
          });
          const assertSql = Effect.fn("ResetData.assertSql")(
            (client: typeof current, url: string, sql: string) =>
              runSql(client, url, sql).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    expect(result.exitCode, result.stderr).toBe(0);
                  }),
                ),
              ),
          );

          const runningReset = yield* Effect.flip(target.resetData);
          expect(runningReset.message).toContain("must be stopped with wake disabled");
          yield* assertSql(
            current,
            siblingUrl,
            "CREATE TABLE reset_sibling_sentinel(value text NOT NULL); INSERT INTO reset_sibling_sentinel VALUES ('survives');",
          );
          yield* assertSql(
            current,
            targetUrl,
            "CREATE TABLE reset_rows(value text NOT NULL); INSERT INTO reset_rows VALUES ('owned'); CREATE ROLE reset_role",
          );
          yield* assertSql(current, targetUrl, "CREATE DATABASE reset_extra");
          const beforeStatus = yield* target.status;
          const beforeComposition = yield* current.composition.describe;
          const targetPort = new URL(targetUrl).port;

          yield* target.stop;
          yield* target.resetData;
          const resetStatus = yield* target.status;
          expect(resetStatus.lifecycle).toBe("stopped");
          expect(resetStatus.wakeEnabled).toBe(false);
          expect(resetStatus.config).toEqual(beforeStatus.config);
          expect(resetStatus.id).toBe(target.id);
          expect(yield* current.composition.describe).toEqual(beforeComposition);
          const resetCredentials = yield* target.credentials({ from: "runtime" });
          if (resetCredentials.databaseUrl === undefined)
            return yield* Effect.die("reset database credentials missing");
          expect(new URL(resetCredentials.databaseUrl).port).toBe(targetPort);
          expect((yield* sibling.status).lifecycle).toBe("running");
          const siblingMarker = yield* assertSql(
            current,
            siblingUrl,
            "SELECT value FROM reset_sibling_sentinel",
          );
          expect(siblingMarker.stdout.trim()).toBe("survives");

          yield* target.start;
          yield* target.ready;
          const cleared = yield* assertSql(
            current,
            targetUrl,
            "SELECT to_regclass('public.reset_rows') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reset_role') AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'reset_extra')",
          );
          expect(cleared.stdout.trim()).toBe("t");

          yield* target.stop;
          yield* target.resetData;
          yield* current.stop;
          const reopened = yield* open({ ...options, id: current.id });
          const reopenedTarget = yield* reopened.services.get(target.id);
          if (reopenedTarget.service !== "database")
            return yield* Effect.die("reopened target is not a database");
          yield* reopenedTarget.start;
          yield* reopenedTarget.ready;
          const reopenedCredentials = yield* reopenedTarget.credentials({ from: "runtime" });
          if (reopenedCredentials.databaseUrl === undefined)
            return yield* Effect.die("reopened database credentials missing");
          expect(new URL(reopenedCredentials.databaseUrl).port).toBe(targetPort);
          const reopenedCleared = yield* assertSql(
            reopened,
            reopenedCredentials.databaseUrl,
            "SELECT to_regclass('public.reset_rows') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reset_role') AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'reset_extra')",
          );
          expect(reopenedCleared.stdout.trim()).toBe("t");
        }),
      (owned) =>
        Effect.exit(owned.destroy).pipe(
          Effect.map((exit) => {
            expect(Exit.isSuccess(exit)).toBe(true);
          }),
        ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer));

it.live("resets native database data through the public RPC", () => resetDataStory("native"), {
  timeout: 10 * 60_000,
});

it.live("resets Docker database data through the public RPC", () => resetDataStory("docker"), {
  timeout: 15 * 60_000,
});
