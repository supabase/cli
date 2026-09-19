import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { dbConnectionLayer } from "../../../../command-internal/db-connection.layer.ts";
import { DbConnection } from "../../../../command-internal/db-connection.service.ts";
import { parseConnectionString } from "../../../../command-internal/db-config.parse.ts";
import { stackCatalogSetupLayer } from "../../../../command-internal/stack-catalog-setup.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { ExperimentalFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { stackStart } from "./start.handler.ts";
import { stackPrepare } from "../prepare/prepare.handler.ts";

const excluded = [
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
];
const flags = (exclude: ReadonlyArray<string>) => ({
  exclude,
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  preparation: "on-demand" as const,
  eager: false,
});

const prepareFlags = () => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  capability: [],
});

const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

const projectConfig = `
project_id = "stack-start-native-integration"

[api]
enabled = true

[auth]
enabled = false

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

const makeLayers = (root: string) => {
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const resolver = stackTargetResolverLayer.pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, settings, liveStackApi)),
  );
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const tty = mockTty({ stdinIsTty: false, stdoutIsTty: false });
  return {
    output,
    telemetry,
    layer: Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      runtimeInfoLayer,
      settings,
      liveStackApi,
      resolver,
      output.layer,
      telemetry.layer,
      stackCatalogSetupLayer,
      dbConnectionLayer,
      Layer.succeed(ExperimentalFlag, false),
      Layer.succeed(YesFlag, false),
      Layer.succeed(CliArgs, { args: ["stack", "start"] }),
      Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
      stdinLayer.pipe(Layer.provide(tty)),
      tty,
    ),
  };
};

describe("experimental stack start native lifecycle", () => {
  it.live(
    "preserves database identity, data, and port while excluding then including REST",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-native-" });
        yield* fs.makeDirectory(path.join(root, "supabase", "migrations"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "supabase", "migrations", "20260919000000_native_start.sql"),
          "THIS IS NOT SQL;\n",
        );
        yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), projectConfig);
        const fixture = makeLayers(root);
        let stackId: string | undefined;
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.scoped(stackPrepare(prepareFlags()));
            const api = yield* StackApi;
            const failedStart = yield* Effect.scoped(Effect.exit(stackStart(flags([]))));
            expect(Exit.isFailure(failedStart)).toBe(true);
            const failedDefinitions = yield* api.discover({ stateRoot: path.join(root, "stacks") });
            expect(failedDefinitions).toHaveLength(1);
            const failedDefinition = failedDefinitions[0];
            if (failedDefinition === undefined)
              return yield* Effect.die("registered stack missing");
            {
              const failedStack = yield* api.open({
                id: failedDefinition.definition.id,
                stateRoot: path.join(root, "stacks"),
                cacheRoot: path.join(root, "cache"),
              });
              expect(yield* failedStack.services.list).toHaveLength(0);
              expect((yield* failedStack.composition.describe).members).toHaveLength(0);
            }
            yield* fs.writeFileString(
              path.join(root, "supabase", "migrations", "20260919000000_native_start.sql"),
              "CREATE TABLE native_migration_probe(value text NOT NULL); INSERT INTO native_migration_probe(value) VALUES ('once');\n",
            );
            stackId = yield* stackStart(flags(excluded));
            const stack = yield* api.open({
              id: stackId,
              stateRoot: path.join(root, "stacks"),
              cacheRoot: path.join(root, "cache"),
            });
            const firstDatabase = (yield* stack.services.list).find(
              (instance) => instance.service === "database",
            );
            if (firstDatabase === undefined) return yield* Effect.die("database missing");
            const firstCredentials = yield* firstDatabase.credentials({ from: "host" });
            const firstDatabaseUrl = firstCredentials.databaseUrl;
            if (firstDatabaseUrl === undefined) return yield* Effect.die("database URL missing");
            const firstConnection = parseConnectionString(firstDatabaseUrl);
            if (firstConnection === undefined) return yield* Effect.die("database URL invalid");
            const db = yield* DbConnection;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* db.connect(firstConnection, {
                  isLocal: true,
                  dnsResolver: "native",
                });
                yield* session.exec("CREATE TABLE native_start_probe(value text NOT NULL)");
                yield* session.exec("INSERT INTO native_start_probe(value) VALUES ('preserved')");
                const migrationRows = yield* session.query(
                  "SELECT value FROM native_migration_probe",
                );
                expect(migrationRows).toEqual([{ value: "once" }]);
              }),
            );
            const secondId = yield* stackStart(flags([]));
            expect(secondId).toBe(stackId);
            const thirdId = yield* stackStart(flags([]));
            expect(thirdId).toBe(stackId);
            const reopened = yield* api.open({
              id: secondId,
              stateRoot: path.join(root, "stacks"),
              cacheRoot: path.join(root, "cache"),
            });
            const services = yield* reopened.services.list;
            const secondDatabase = services.find((instance) => instance.service === "database");
            if (secondDatabase === undefined) return yield* Effect.die("reopened database missing");
            expect(secondDatabase.id).toBe(firstDatabase.id);
            const secondCredentials = yield* secondDatabase.credentials({ from: "host" });
            expect(secondCredentials.databaseUrl).toBe(firstDatabaseUrl);
            const secondConnection = parseConnectionString(secondCredentials.databaseUrl ?? "");
            if (secondConnection === undefined) return yield* Effect.die("reopened URL invalid");
            const rows = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* db.connect(secondConnection, {
                  isLocal: true,
                  dnsResolver: "native",
                });
                return yield* session.query("SELECT value FROM native_start_probe");
              }),
            );
            expect(rows).toEqual([{ value: "preserved" }]);
            expect(services.some((instance) => instance.service === "rest")).toBe(true);
          }),
          Effect.exit(
            Effect.gen(function* () {
              const api = yield* StackApi;
              if (stackId === undefined) return;
              const stack = yield* api.open({
                id: stackId,
                stateRoot: path.join(root, "stacks"),
                cacheRoot: path.join(root, "cache"),
              });
              yield* Effect.exit(stack.destroy).pipe(Effect.asVoid);
            }),
          ).pipe(Effect.asVoid),
        ).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 180_000 },
  );
});
