import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { postgres } from "./Tools.ts";
import * as ToolRunner from "./host/ToolRunner.ts";
import { makeDatabase } from "./services/Database.ts";
import { makeService } from "./Service.ts";
import { bindTcp, serveTcp } from "./Proxy.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

class PgProveTestError extends Data.TaggedError("PgProveTestError")<{
  readonly message: string;
}> {}

const makeTestToolRunner = (options: {
  readonly stackId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: "native" | "docker" | "podman";
}) =>
  Layer.build(ToolRunner.layer(options)).pipe(
    Effect.map((context) => Context.get(context, ToolRunner.Service)),
  );

describe("finite PostgreSQL tools", { timeout: 180_000 }, () => {
  for (const runtime of ["native", "docker"] as const) {
    it.live(`${runtime} runs SQL from stdin, streams a dump, and returns client failure`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-tools-" });
          const stackId = "tools-integration";
          const database = yield* makeDatabase({
            root,
            cacheRoot,
            stackId,
            instanceId: "database",
            runtime,
          });
          const service = yield* makeService(database.definition, {
            id: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("tool-password"),
              jwtSecret: Redacted.make("tool-jwt-secret-at-least-thirty-two-characters"),
              jwtExpiry: 3600,
            },
          });
          yield* service.start;
          yield* service.ready;
          const endpoint = yield* database.endpoint;
          const listener = yield* bindTcp(runtime === "native" ? "127.0.0.1" : "0.0.0.0", 0);
          if (!Predicate.isTagged(listener.address, "TcpAddress"))
            return yield* Effect.die("Expected TCP listener");
          yield* serveTcp(
            listener,
            Effect.succeed(
              endpoint.kind === "unix" ? { path: `${endpoint.path}/.s.PGSQL.5432` } : endpoint,
            ),
          ).pipe(Effect.forkScoped);
          const runner = yield* makeTestToolRunner({ root, cacheRoot, stackId, runtime });
          const env = {
            PGHOST: runtime === "native" ? "127.0.0.1" : "host.docker.internal",
            PGPORT: String(listener.address.port),
            PGUSER: "supabase_admin",
            PGPASSWORD: "tool-password",
            PGDATABASE: "postgres",
          };
          const stdout = yield* Ref.make("");
          const stderr = yield* Ref.make("");
          const output = {
            stdout: (bytes: Uint8Array) =>
              Ref.update(stdout, (text) => text + new TextDecoder().decode(bytes)),
            stderr: (bytes: Uint8Array) =>
              Ref.update(stderr, (text) => text + new TextDecoder().decode(bytes)),
          };
          const sql = yield* runner.run({
            tool: postgres.psql({ major: 17 }),
            args: ["-X", "-v", "ON_ERROR_STOP=1"],
            env,
            stdin: Stream.make(
              new TextEncoder().encode(
                "CREATE TABLE tool_story(value text); INSERT INTO tool_story VALUES ('streamed-row'); SELECT value FROM tool_story;",
              ),
            ),
            ...output,
          });
          expect(sql.exitCode).toBe(0);
          expect(yield* Ref.get(stdout)).toContain("streamed-row");
          yield* Ref.set(stdout, "");
          const dump = yield* runner.run({
            tool: postgres.pgDump({ major: 17 }),
            args: ["--data-only", "--table=tool_story"],
            env,
            ...output,
          });
          expect(dump.exitCode).toBe(0);
          expect(dump.jobId).not.toBe(sql.jobId);
          expect(yield* Ref.get(stdout)).toContain("COPY public.tool_story");
          expect(yield* Ref.get(stdout)).toContain("streamed-row");
          const failed = yield* runner.run({
            tool: postgres.psql({ major: 17 }),
            args: ["-X", "-v", "ON_ERROR_STOP=1", "-c", "SELECT missing_column FROM tool_story"],
            env,
            ...output,
          });
          expect(failed.exitCode).not.toBe(0);
          expect(yield* Ref.get(stderr)).toContain("missing_column");
          const rejected = yield* Effect.flip(
            runner.run({
              tool: postgres.psql({ major: 17 }),
              args: [],
              env,
              pgProve: { mounts: [] },
              ...output,
            }),
          );
          expect(rejected.message).toContain("pgProve options require the pg_prove tool");
          yield* Ref.set(stderr, "");
          const early = yield* runner.run({
            tool: postgres.psql({ major: 17 }),
            args: ["-X", "-v", "ON_ERROR_STOP=1"],
            env,
            stdin: Stream.make(
              new TextEncoder().encode(
                "SELECT missing_column FROM tool_story;\n" + "SELECT 1;\n".repeat(150_000),
              ),
            ),
            ...output,
          });
          expect(early.exitCode).not.toBe(0);
          expect(yield* Ref.get(stderr)).toContain("missing_column");
          const attached = yield* Deferred.make<void>();
          const job = yield* runner
            .run({
              tool: postgres.psql({ major: 17 }),
              args: ["-X", "-q", "-t", "-A"],
              env: { ...env, PGAPPNAME: "attached-tool-story" },
              stdin: Stream.make(new TextEncoder().encode("SELECT 'attached-ready';\n")).pipe(
                Stream.concat(Stream.never),
              ),
              stdout: (bytes) =>
                new TextDecoder().decode(bytes).includes("attached-ready")
                  ? Deferred.succeed(attached, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              stderr: output.stderr,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(attached);
          yield* Fiber.interrupt(job);
          yield* Ref.set(stdout, "");
          const remaining = yield* runner.run({
            tool: postgres.psql({ major: 17 }),
            args: [
              "-X",
              "-t",
              "-A",
              "-c",
              "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'attached-tool-story'",
            ],
            env,
            ...output,
          });
          expect(remaining.exitCode).toBe(0);
          expect((yield* Ref.get(stdout)).trim()).toBe("0");
          expect(yield* fs.readDirectory(`${root}/jobs`)).toEqual([]);
          yield* service.destroy;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    );
  }

  for (const major of [15, 17] as const) {
    for (const runtime of ["native", "docker"] as const) {
      it.live(`${runtime} runs bundled pg_prove for PostgreSQL ${major}`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-pgprove-${major}-` });
            const stackId = `tools-pgprove-${runtime}-${major}`;
            const database = yield* makeDatabase({
              root,
              cacheRoot,
              stackId,
              instanceId: "database",
              runtime,
            });
            const service = yield* makeService(database.definition, {
              id: "database",
              config: {
                version: String(major),
                databasePassword: Redacted.make(`pgprove-${runtime}-${major}-password`),
                jwtSecret: Redacted.make("tool-jwt-secret-at-least-thirty-two-characters"),
                jwtExpiry: 3600,
              },
            });
            yield* service.start;
            yield* service.ready;
            const endpoint = yield* database.endpoint;
            const listener = yield* bindTcp(runtime === "native" ? "127.0.0.1" : "0.0.0.0", 0);
            if (!Predicate.isTagged(listener.address, "TcpAddress"))
              return yield* Effect.die("Expected TCP listener");
            yield* serveTcp(
              listener,
              Effect.succeed(
                endpoint.kind === "unix" ? { path: `${endpoint.path}/.s.PGSQL.5432` } : endpoint,
              ),
            ).pipe(Effect.forkScoped);
            const runner = yield* makeTestToolRunner({ root, cacheRoot, stackId, runtime });
            const env = {
              PGHOST: runtime === "native" ? "127.0.0.1" : "host.docker.internal",
              PGPORT: String(listener.address.port),
              PGUSER: "supabase_admin",
              PGPASSWORD: `pgprove-${runtime}-${major}-password`,
              PGDATABASE: "postgres",
            };
            const tests = `${root}/tests`;
            yield* fs.makeDirectory(tests, { recursive: true });
            yield* fs.writeFileString(`${tests}/main.sql`, "\\ir included.sql\n");
            yield* fs.writeFileString(`${tests}/included.sql`, "\\i nested.sql\n");
            yield* fs.writeFileString(
              `${tests}/nested.sql`,
              "SELECT plan(1);\nSELECT pass('relative include');\nSELECT * FROM finish();\n",
            );
            const stdout = yield* Ref.make("");
            const stderr = yield* Ref.make("");
            const output = {
              stdout: (bytes: Uint8Array) =>
                Ref.update(stdout, (text) => text + new TextDecoder().decode(bytes)),
              stderr: (bytes: Uint8Array) =>
                Ref.update(stderr, (text) => text + new TextDecoder().decode(bytes)),
            };
            const extension = yield* runner.run({
              tool: postgres.psql({ major }),
              args: ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS pgtap"],
              env,
              ...output,
            });
            expect(extension.exitCode).toBe(0);
            const pgProve = (file: string) =>
              runner.run({
                tool: postgres.pgProve({ major }),
                args: ["--ext", ".sql", file, "--verbose"],
                env,
                pgProve: {
                  mounts: [{ source: tests, target: "/tests" }],
                  cwd: tests,
                  workingDir: "/tests",
                },
                ...output,
              });
            yield* Ref.set(stdout, "");
            const passed = yield* pgProve("main.sql");
            expect(passed.exitCode).toBe(0);
            expect(yield* Ref.get(stdout)).toMatch(/^ok 1\b/m);
            expect(yield* Ref.get(stdout)).toContain("relative include");
            expect(yield* fs.readFileString(`${tests}/included.sql`)).toContain("\\i nested.sql");
            expect(yield* fs.readFileString(`${tests}/nested.sql`)).toContain("relative include");

            yield* fs.writeFileString(
              `${tests}/failed.sql`,
              "SELECT plan(1);\nSELECT fail('expected failure');\nSELECT * FROM finish();\n",
            );
            yield* Ref.set(stdout, "");
            const failed = yield* pgProve("failed.sql");
            expect(failed.exitCode).not.toBe(0);
            expect(yield* Ref.get(stdout)).toContain("not ok");
            expect(yield* fs.readFileString(`${tests}/failed.sql`)).toContain("expected failure");
            if (runtime === "native" && major === 17) {
              yield* Effect.gen(function* () {
                const ready = yield* Deferred.make<void>();
                const applicationName = `pgprove-cancel-${randomUUID()}`;
                yield* fs.writeFileString(
                  `${tests}/cancel-ready.sql`,
                  "SELECT plan(1);\nSELECT pass('pgprove-ready');\nSELECT * FROM finish();\n",
                );
                yield* fs.writeFileString(
                  `${tests}/cancel.sql`,
                  "SELECT plan(1);\nSELECT pass('pgprove-idle');\n\\watch 60\n",
                );
                const cancelOutput = yield* Ref.make("");
                const running = yield* runner
                  .run({
                    tool: postgres.pgProve({ major }),
                    args: ["--ext", ".sql", "cancel-ready.sql", "cancel.sql", "--verbose"],
                    env: { ...env, PGAPPNAME: applicationName },
                    pgProve: {
                      mounts: [{ source: tests, target: "/tests" }],
                      cwd: tests,
                      workingDir: "/tests",
                    },
                    stdout: (bytes) =>
                      Effect.gen(function* () {
                        yield* Ref.update(
                          cancelOutput,
                          (text) => text + new TextDecoder().decode(bytes),
                        );
                        if ((yield* Ref.get(cancelOutput)).includes("pgprove-ready"))
                          yield* Deferred.succeed(ready, undefined);
                      }),
                    stderr: output.stderr,
                  })
                  .pipe(Effect.forkChild);
                yield* Deferred.await(ready);
                const idleOutput = yield* Ref.make("");
                const idle = Effect.gen(function* () {
                  yield* Ref.set(idleOutput, "");
                  const probe = yield* runner.run({
                    tool: postgres.psql({ major }),
                    args: [
                      "-X",
                      "-t",
                      "-A",
                      "-c",
                      `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${applicationName}' AND state = 'idle' AND query LIKE '%pgprove-idle%'`,
                    ],
                    env,
                    stdout: (bytes) =>
                      Ref.update(idleOutput, (text) => text + new TextDecoder().decode(bytes)),
                    stderr: output.stderr,
                  });
                  const count = (yield* Ref.get(idleOutput)).trim();
                  if (probe.exitCode !== 0 || count !== "1")
                    return yield* new PgProveTestError({
                      message: `Expected one idle pg_prove session, got ${count}`,
                    });
                  return count;
                }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));
                expect(yield* idle).toBe("1");
                yield* Fiber.interrupt(running);
                const remainingOutput = yield* Ref.make("");
                const remaining = Effect.gen(function* () {
                  yield* Ref.set(remainingOutput, "");
                  const probe = yield* runner.run({
                    tool: postgres.psql({ major }),
                    args: [
                      "-X",
                      "-t",
                      "-A",
                      "-c",
                      `SELECT count(*)::text || ':' || coalesce(string_agg(pid::text || ':' || state || ':' || coalesce(wait_event, '') || ':' || query, '|'), '') FROM pg_stat_activity WHERE application_name = '${applicationName}'`,
                    ],
                    env,
                    stdout: (bytes) =>
                      Ref.update(remainingOutput, (text) => text + new TextDecoder().decode(bytes)),
                    stderr: output.stderr,
                  });
                  const details = (yield* Ref.get(remainingOutput)).trim();
                  const count = details.split(":", 1)[0];
                  if (probe.exitCode !== 0 || count !== "0")
                    return yield* new PgProveTestError({
                      message: `Expected no pg_prove session, got ${details}`,
                    });
                  return details;
                }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));
                expect((yield* remaining).split(":", 1)[0]).toBe("0");
                expect(yield* fs.readDirectory(`${root}/jobs`)).toEqual([]);
              });
            }
            yield* service.destroy;
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      );
    }
  }
});
