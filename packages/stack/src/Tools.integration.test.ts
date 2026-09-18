import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { tmpdir } from "node:os";
import { postgres } from "./Tools.ts";
import * as ToolRunner from "./host/ToolRunner.ts";
import { makeDatabase } from "./services/Database.ts";
import { makeService } from "./Service.ts";
import { bindTcp, serveTcp } from "./Proxy.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

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
});
