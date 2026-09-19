import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { Effect, FileSystem, Layer, Option, Redacted, Ref, Stream } from "effect";
import { postgres, type ServiceCreation } from "@supabase/stack/effect";

import { StackApi, stackApiLayer } from "./stack-api.ts";
import { streamPgDumpWithClient } from "./pg-dump.run.ts";
import { NetworkIdFlag } from "./global-flags.ts";
import { DockerRun } from "./docker-run.service.ts";
import { BundledPostgresClient } from "./bundled-postgres-client.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";

const runtimes = ["native", "docker"] as const;
const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

describe("managed pg_dump against a live stack", { timeout: 180_000 }, () => {
  for (const runtime of runtimes) {
    it.live(`${runtime} uses runtime credentials and preserves dump filters`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-pg-dump-" });
          const api = yield* StackApi;
          const stack = yield* api.create({
            projectRoot: root,
            stateRoot: `${root}/stacks`,
            cacheRoot: `${root}/cache`,
            runtime,
          });
          yield* Effect.addFinalizer(() =>
            stack.destroy.pipe(
              Effect.tapError((error) => Effect.logError(`Failed to destroy test stack: ${error}`)),
              Effect.ignore,
            ),
          );
          const creation: Extract<ServiceCreation, { service: "database" }> = {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("cli-dump-password"),
              jwtSecret: Redacted.make("cli-dump-jwt-secret-at-least-thirty-two-characters"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          };
          const [database] = yield* stack.composition.supabase([creation]);
          if (database === undefined) return yield* Effect.die("database was not composed");
          yield* database.start;
          yield* database.ready;
          const credentials = yield* database.credentials({ from: "runtime" });
          const output = yield* Ref.make<Uint8Array[]>([]);
          const stderr = yield* Ref.make<Uint8Array[]>([]);
          const sql = credentials.databaseUrl;
          if (sql === undefined) return yield* Effect.die("runtime database URL missing");
          const connection = new URL(sql);
          const env = {
            PGHOST: connection.hostname,
            PGPORT: connection.port,
            PGUSER: decodeURIComponent(connection.username),
            PGPASSWORD: decodeURIComponent(connection.password),
            PGDATABASE: connection.pathname.slice(1),
          };
          const setupResult = yield* stack.tools.run(postgres.psql({ major: 17 }), {
            args: ["-X", "-v", "ON_ERROR_STOP=1"],
            env,
            stdin: Stream.make(
              new TextEncoder().encode(
                "CREATE TABLE public.cli_dump_story(value text); INSERT INTO public.cli_dump_story VALUES ('runtime-row');",
              ),
            ),
            stdout: (bytes) => Ref.update(output, (chunks) => [...chunks, bytes]),
            stderr: (bytes) => Ref.update(stderr, (chunks) => [...chunks, bytes]),
          });
          expect(setupResult.exitCode).toBe(0);
          const dumpEnv = {
            ...env,
            EXCLUDED_SCHEMAS: "auth|storage",
          };
          const chunks = yield* Ref.make<Uint8Array[]>([]);
          const result = yield* streamPgDumpWithClient({
            image: "unused",
            script: "pg_dump --data-only",
            env: dumpEnv,
            onStdout: (bytes) => Ref.update(chunks, (current) => [...current, bytes]),
            client: { kind: "stack", stack, command: "pg_dump", major: 17 },
          });
          expect(result.exitCode).toBe(0);
          const dump = new TextDecoder().decode(
            Uint8Array.from((yield* Ref.get(chunks)).flatMap((chunk) => [...chunk])),
          );
          expect(dump).toContain("cli_dump_story");
          expect(dump).toContain("runtime-row");
          expect(yield* Ref.get(stderr)).toHaveLength(0);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            FetchHttpClient.layer,
            liveStackApi,
            Layer.succeed(NetworkIdFlag, Option.none()),
            Layer.succeed(RuntimeInfo, {
              cwd: "/tmp",
              platform: process.platform,
              arch: process.arch,
              homeDir: "/tmp",
              execPath: process.execPath,
              pid: process.pid,
            }),
            Layer.succeed(BundledPostgresClient, { run: () => Effect.die("unused") }),
            Layer.succeed(DockerRun, {
              run: () => Effect.die("unused"),
              runCapture: () => Effect.die("unused"),
              runStream: () => Effect.die("unused"),
            }),
            mockOutput().layer,
          ),
        ),
      ),
    );
  }
});
