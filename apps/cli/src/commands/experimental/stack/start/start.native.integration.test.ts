import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as net from "node:net";
import type { Stack } from "@supabase/stack/effect";
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
import { destroyTestStacks } from "../../../../../tests/helpers/stack-cleanup.ts";

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

const captureOwnerPid = (capture: (pid: number) => void) =>
  Layer.effect(
    StackApi,
    Effect.gen(function* () {
      const api = yield* Effect.provide(Effect.service(StackApi), liveStackApi);
      const observe = (stack: Stack, stateRoot: string): Stack => ({
        ...stack,
        composition: {
          ...stack.composition,
          supabase: (services, compositionOptions) =>
            stack.composition.supabase(services, compositionOptions).pipe(
              Effect.onExit(() =>
                api.discover({ stateRoot }).pipe(
                  Effect.flatMap((definitions) => {
                    const host = definitions.find(
                      ({ definition }) => definition.id === stack.id,
                    )?.host;
                    return host === undefined
                      ? Effect.die("Stack owner was not discoverable")
                      : Effect.sync(() => capture(host.pid));
                  }),
                ),
              ),
            ),
        },
      });
      const captureOpenOwner = (stack: Stack, stateRoot: string) =>
        api.discover({ stateRoot }).pipe(
          Effect.flatMap((definitions) => {
            const host = definitions.find(({ definition }) => definition.id === stack.id)?.host;
            return host === undefined ? Effect.void : Effect.sync(() => capture(host.pid));
          }),
        );
      return StackApi.of({
        ...api,
        create: (options) =>
          api.create(options).pipe(Effect.map((stack) => observe(stack, options.stateRoot))),
        open: (options) =>
          api.open(options).pipe(
            Effect.tap((stack) =>
              options.startOwner === true
                ? captureOpenOwner(stack, options.stateRoot)
                : Effect.void,
            ),
            Effect.map((stack) => observe(stack, options.stateRoot)),
          ),
      });
    }),
  );

const ownerHasExited = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH")
        return true;
      throw cause;
    }
  });

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

const makeLayers = (root: string, apiLayer = liveStackApi) => {
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const resolver = stackTargetResolverLayer.pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, settings, apiLayer)),
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
      apiLayer,
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
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.scoped(stackPrepare(prepareFlags()));
            const api = yield* StackApi;
            const preparedDefinitions = yield* api.discover({
              stateRoot: path.join(root, "stacks"),
            });
            const existingOwnerPid = preparedDefinitions[0]?.host?.pid;
            if (existingOwnerPid === undefined)
              return yield* Effect.die("prepared stack owner missing");
            const failedStart = yield* Effect.scoped(Effect.exit(stackStart(flags([]))));
            expect(Exit.isFailure(failedStart)).toBe(true);
            const failedDefinitions = yield* api.discover({ stateRoot: path.join(root, "stacks") });
            expect(failedDefinitions).toHaveLength(1);
            const failedDefinition = failedDefinitions[0];
            if (failedDefinition === undefined)
              return yield* Effect.die("registered stack missing");
            expect(failedDefinition.host?.pid).toBe(existingOwnerPid);
            expect(() => process.kill(existingOwnerPid, 0)).not.toThrow();
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
            const stackId = yield* stackStart(flags(excluded));
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
            expect(services.some((instance) => instance.service === "rest")).toBe(false);
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
            yield* reopened.stop;
            const restartedId = yield* stackStart(flags([]));
            expect(restartedId).toBe(stackId);
            const restarted = yield* api.open({
              id: restartedId,
              stateRoot: path.join(root, "stacks"),
              cacheRoot: path.join(root, "cache"),
            });
            const restartedServices = yield* restarted.services.list;
            const restartedDatabase = restartedServices.find(
              (instance) => instance.service === "database",
            );
            if (restartedDatabase === undefined)
              return yield* Effect.die("restarted database missing");
            expect(restartedServices.some((instance) => instance.service === "rest")).toBe(true);
            expect(restartedDatabase.id).toBe(firstDatabase.id);
            const restartedCredentials = yield* restartedDatabase.credentials({ from: "host" });
            expect(restartedCredentials.databaseUrl).toBe(firstDatabaseUrl);
            const restartedConnection = parseConnectionString(
              restartedCredentials.databaseUrl ?? "",
            );
            if (restartedConnection === undefined)
              return yield* Effect.die("restarted URL invalid");
            const restartedRows = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* db.connect(restartedConnection, {
                  isLocal: true,
                  dnsResolver: "native",
                });
                return yield* session.query("SELECT value FROM native_start_probe");
              }),
            );
            expect(restartedRows).toEqual([{ value: "preserved" }]);
          }),
          Effect.gen(function* () {
            const api = yield* StackApi;
            yield* destroyTestStacks(api, path.join(root, "stacks"), path.join(root, "cache"));
          }),
        ).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 180_000 },
  );

  it.live(
    "stops owners after bind and pre-compose config failures across retries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-native-bind-" });
        yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
        const server = net.createServer();
        const ownedServer = yield* Effect.acquireRelease(
          Effect.callback<net.Server, Error>((resume) => {
            const onError = (cause: Error) => resume(Effect.fail(cause));
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
              server.removeListener("error", onError);
              resume(Effect.succeed(server));
            });
            return Effect.sync(() => {
              server.removeListener("error", onError);
              if (server.listening) server.close();
            });
          }),
          (listeningServer) =>
            Effect.callback<void>((resume) => {
              listeningServer.close(() => resume(Effect.void));
            }),
        );
        const address = ownedServer.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("Unable to reserve a native test port");
        const occupiedPort = address.port;
        yield* fs.writeFileString(
          path.join(root, "supabase", "config.toml"),
          projectConfig.replace("[db.pooler]", `[db]\nport = ${occupiedPort}\n\n[db.pooler]`),
        );
        const ownerPids: Array<number> = [];
        let activeAttempt = 0;
        const fixture = makeLayers(
          root,
          captureOwnerPid((pid) => (ownerPids[activeAttempt] = pid)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const api = yield* StackApi;
            yield* Effect.addFinalizer(() =>
              destroyTestStacks(api, path.join(root, "stacks"), path.join(root, "cache")),
            );
            let stackId: string | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
              activeAttempt = attempt;
              const failedStart = yield* Effect.scoped(Effect.exit(stackStart(flags([]))));
              expect(Exit.isFailure(failedStart)).toBe(true);
              if (!Exit.isFailure(failedStart)) return;
              // Linux rejects the bind; platforms that allow overlapping binds reject the probe.
              expect(Cause.pretty(failedStart.cause)).toMatch(
                new RegExp(
                  `127\\.0\\.0\\.1:${occupiedPort}(: Cannot bind TCP listener| is already in use)`,
                ),
              );
              const ownerPid = ownerPids[attempt];
              expect(ownerPid).toBeDefined();
              if (ownerPid === undefined) return yield* Effect.die("stack owner PID missing");
              expect(yield* ownerHasExited(ownerPid)).toBe(true);
              const definitions = yield* api.discover({ stateRoot: path.join(root, "stacks") });
              expect(definitions).toHaveLength(1);
              const definition = definitions[0];
              if (definition === undefined) return yield* Effect.die("registered stack missing");
              if (stackId === undefined) stackId = definition.definition.id;
              else expect(definition.definition.id).toBe(stackId);
              expect(definition.host).toBeUndefined();
              const stack = yield* api.open({
                id: definition.definition.id,
                stateRoot: path.join(root, "stacks"),
                cacheRoot: path.join(root, "cache"),
              });
              expect(yield* stack.services.list).toHaveLength(0);
              expect((yield* stack.composition.describe).members).toHaveLength(0);
            }
            yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), "project_id = [");
            activeAttempt = 2;
            const invalidConfigStart = yield* Effect.scoped(Effect.exit(stackStart(flags([]))));
            expect(Exit.isFailure(invalidConfigStart)).toBe(true);
            if (!Exit.isFailure(invalidConfigStart)) return;
            const configError = Cause.findErrorOption(invalidConfigStart.cause);
            expect(Option.isSome(configError)).toBe(true);
            if (Option.isSome(configError))
              expect(configError.value).toMatchObject({ reason: "invalid-config" });
            const configFailureOwnerPid = ownerPids[2];
            expect(configFailureOwnerPid).toBeDefined();
            if (configFailureOwnerPid === undefined)
              return yield* Effect.die("owner PID missing after config failure");
            expect(yield* ownerHasExited(configFailureOwnerPid)).toBe(true);
            const definitions = yield* api.discover({ stateRoot: path.join(root, "stacks") });
            expect(definitions).toHaveLength(1);
            const definition = definitions[0];
            if (definition === undefined) return yield* Effect.die("registered stack missing");
            expect(definition.definition.id).toBe(stackId);
            expect(definition.host).toBeUndefined();
            const stack = yield* api.open({
              id: definition.definition.id,
              stateRoot: path.join(root, "stacks"),
              cacheRoot: path.join(root, "cache"),
            });
            expect(yield* stack.services.list).toHaveLength(0);
            expect((yield* stack.composition.describe).members).toHaveLength(0);
            expect(ownerPids.filter((pid) => pid !== undefined)).toHaveLength(3);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 60_000 },
  );
});
