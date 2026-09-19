import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Redacted } from "effect";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { CommandRuntime } from "../shared/runtime/command-runtime.service.ts";
import { mockOutput, mockProcessControl } from "../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { BundledPostgresClient } from "./bundled-postgres-client.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { DbConnection } from "./db-connection.service.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DebugFlag, DnsResolverFlag, NetworkIdFlag } from "./global-flags.ts";
import { StackApi, stackApiLayer } from "./stack-api.ts";
import { stackBackendLayer } from "./stack-backend.ts";
import { testDb } from "./test-db.handler.ts";
import { runTestDbCommand } from "./test-db.command-handler.ts";
import { DockerRun } from "./docker-run.service.ts";
import { StackError } from "@supabase/stack/effect";

const runtimes = ["native", "docker"] as const;
const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

const databaseCreation = {
  service: "database" as const,
  config: {
    version: "17",
    databasePassword: Redacted.make("cli-pgtap-password"),
    jwtSecret: Redacted.make("cli-pgtap-jwt-secret-at-least-thirty-two-characters"),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: "auto" as const } },
};

const flags = (path: string) => ({
  paths: [path],
  dbUrl: Option.none<string>(),
  linked: false,
  local: true,
  projectRef: Option.none<string>(),
});

describe("managed test db pgTAP", { timeout: 180_000 }, () => {
  for (const runtime of runtimes) {
    it.live(`${runtime} streams passing and failing pgTAP through test db`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-test-db-" });
          const tests = `${root}/tests`;
          yield* fs.makeDirectory(tests);
          const passing = `${tests}/passing.sql`;
          const failing = `${tests}/failing.sql`;
          yield* fs.writeFileString(
            passing,
            "SELECT plan(1); SELECT is(current_user::text, 'postgres', 'runs as postgres'); SELECT * FROM finish();\n",
          );
          yield* fs.writeFileString(
            failing,
            "SELECT plan(1); SELECT fail('managed pgTAP failure'); SELECT * FROM finish();\n",
          );

          const api = yield* StackApi;
          const stack = yield* Effect.acquireRelease(
            api.create({
              projectRoot: root,
              stateRoot: `${root}/stacks`,
              cacheRoot: `${root}/cache`,
              runtime,
            }),
            (stack) => stack.destroy.pipe(Effect.catch((cause) => Effect.die(cause))),
          );
          const [database] = yield* stack.composition.supabase([databaseCreation]);
          if (database === undefined) return yield* Effect.die("database was not composed");
          yield* database.start;
          yield* database.ready;
          const hostCredentials = yield* database.credentials({ from: "host" });
          const databaseUrl = hostCredentials.databaseUrl;
          if (databaseUrl === undefined) return yield* Effect.die("host database URL missing");
          const hostConnection = parseConnectionString(databaseUrl);
          if (hostConnection === undefined) return yield* Effect.die("invalid host database URL");
          const connection = { ...hostConnection, user: "postgres" };

          const output = mockOutput();
          const settings = mockCommandSettings({
            workdir: root,
            supabaseHome: root,
          });
          const services = Layer.mergeAll(
            settings,
            output.layer,
            mockTelemetryStateTracked().layer,
            Layer.succeed(DbConfigResolver, {
              resolve: () => Effect.succeed({ conn: connection, isLocal: true }),
              resolvePoolerFallback: () => Effect.succeed(Option.none()),
            }),
            Layer.succeed(RuntimeInfo, {
              cwd: root,
              platform: process.platform,
              arch: process.arch,
              homeDir: root,
              execPath: process.execPath,
              pid: process.pid,
            }),
            Layer.succeed(DebugFlag, true),
            Layer.succeed(DnsResolverFlag, "native" as const),
            Layer.succeed(NetworkIdFlag, Option.none()),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(BundledPostgresClient, { run: () => Effect.die("unused") }),
            Layer.succeed(DockerRun, {
              run: () => Effect.die("unused"),
              runCapture: () => Effect.die("unused"),
              runStream: () => Effect.die("unused"),
            }),
            stackBackendLayer("stack"),
            dbConnectionLayer,
          );
          const assertPgtapDropped = Effect.gen(function* () {
            const dbConnection = yield* DbConnection;
            const session = yield* dbConnection.connect(connection, {
              isLocal: true,
              dnsResolver: "native",
            });
            expect(yield* session.extensionExists("pgtap")).toBe(false);
          });

          yield* testDb(flags(passing)).pipe(Effect.provide(services));
          expect(output.stdoutText).toContain("Result: PASS");
          yield* assertPgtapDropped.pipe(Effect.provide(services));

          const failedOutput = mockOutput();
          const failedExit = yield* Effect.exit(
            testDb(flags(failing)).pipe(Effect.provide(Layer.merge(services, failedOutput.layer))),
          );
          expect(Exit.isFailure(failedExit)).toBe(true);
          if (Exit.isFailure(failedExit)) {
            const failure = Cause.findErrorOption(failedExit.cause);
            expect(Option.isSome(failure)).toBe(true);
            if (Option.isSome(failure)) {
              expect(failure.value).toMatchObject({
                _tag: "TestDbRunError",
              });
              expect(failure.value.message).toMatch(/^error running pg_prove:/);
            }
          }
          expect(failedOutput.stdoutText).toContain("not ok");
          expect(failedOutput.stderrText).toContain("Connecting to local database");
          yield* assertPgtapDropped.pipe(Effect.provide(services));

          if (runtime !== "native") return;
          const partialTap = "not ok 1 - managed tool failed after streaming\n";
          const jsonOutput = mockOutput({ format: "json" });
          const processControl = mockProcessControl();
          const failingStackApi = Layer.succeed(StackApi, {
            ...api,
            open: () =>
              Effect.succeed({
                ...stack,
                tools: {
                  ...stack.tools,
                  run: (_tool, options) =>
                    Effect.gen(function* () {
                      yield* options.stdout(new TextEncoder().encode(partialTap));
                      return yield* Effect.fail(
                        new StackError({ operation: "tool", message: "pg_prove unavailable" }),
                      );
                    }),
                },
              }),
          });
          yield* runTestDbCommand(flags(failing)).pipe(
            Effect.provide(
              Layer.mergeAll(
                services,
                jsonOutput.layer,
                processControl.layer,
                failingStackApi,
                Layer.succeed(CommandRuntime, {
                  commandPath: ["test", "db"],
                  commandRunId: "test-db-native",
                }),
                Layer.succeed(Analytics, {
                  capture: () => Effect.void,
                  identify: () => Effect.void,
                  alias: () => Effect.void,
                  groupIdentify: () => Effect.void,
                }),
              ),
            ),
          );
          expect(jsonOutput.stdoutText).toBe(partialTap);
          expect(jsonOutput.stderrText).toContain("pg_prove run failed: pg_prove unavailable");
          expect(processControl.exitCode).toBe(1);
          yield* assertPgtapDropped.pipe(Effect.provide(services));
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, liveStackApi)),
      ),
    );
  }
});
