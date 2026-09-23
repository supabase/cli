import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Scope,
  Stream,
} from "effect";
import {
  StackError,
  type Observation,
  type ServiceCreation,
  type Stack,
} from "@supabase/stack/effect";
import { StackApi } from "../../../command-internal/stack-api.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { mockCommandSettings } from "../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../tests/helpers/mocks.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { functionsServeStack } from "./serve.stack.handler.ts";

type DatabaseInstance = Extract<
  Effect.Success<ReturnType<Stack["services"]["get"]>>,
  { service: "database" }
>;
type FunctionsInstance = Extract<
  Effect.Success<ReturnType<Stack["services"]["get"]>>,
  { service: "functions" }
>;

const functionsConfig = (): Extract<ServiceCreation, { service: "functions" }>["config"] => ({
  functionsRoot: "/project/supabase/functions",
  bootstrap: "export default {};",
  apiUrl: "http://127.0.0.1:54321",
  databaseUrl: "postgresql://postgres@127.0.0.1:54322/postgres",
  jwtSecret: "jwt-secret",
  verifyJwt: true,
  env: { SHARED: "saved", RETAINED: "retained" },
});

const databaseConfig: Extract<ServiceCreation, { service: "database" }>["config"] = {
  version: "15",
  databasePassword: Redacted.make("postgres"),
  jwtSecret: Redacted.make("jwt-secret"),
  jwtExpiry: 3600,
};

const observation = (
  id: string,
  config: ServiceCreation,
  overrides: Partial<Observation> = {},
): Observation => ({
  id,
  config,
  endpoints: [{ name: "http", protocol: "http", host: "127.0.0.1", port: 54321 }],
  lifecycle: "running",
  health: "healthy",
  currentOperation: undefined,
  error: undefined,
  cleanupError: undefined,
  exit: undefined,
  launchId: 1,
  intentRevision: 1,
  wakeEnabled: false,
  registered: true,
  ...overrides,
});

const flags = (overrides: Partial<Parameters<typeof functionsServeStack>[0]> = {}) => ({
  noVerifyJwt: Option.none<boolean>(),
  envFile: Option.none<string>(),
  importMap: Option.none<string>(),
  inspect: false,
  inspectMode: Option.none<"run" | "brk" | "wait">(),
  inspectMain: false,
  all: true,
  ...overrides,
});

const fixture = (
  options: {
    readonly failRestartOn?: number;
    readonly restartGate?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
      readonly mutationDone: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
    const signal = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const signalControl = mockProcessControl({
      awaitSignal: Deferred.await(signal).pipe(Effect.as("SIGINT" as const)),
    });
    const output = mockOutput({ format: "text", interactive: false });
    const telemetry = Layer.succeed(TelemetryState, {
      flush: Effect.void,
      stitchLogin: () => Effect.void,
      resetIdentity: Effect.void,
      clearDistinctId: Effect.void,
    });
    let currentFunctions = functionsConfig();
    let restartCount = 0;
    let destroyed = false;
    const databaseCreation: Extract<ServiceCreation, { service: "database" }> = {
      service: "database",
      config: databaseConfig,
      endpoints: { sql: { port: 54322 } },
    };
    const functionsCreation = (): Extract<ServiceCreation, { service: "functions" }> => ({
      service: "functions",
      config: currentFunctions,
      endpoints: { http: { port: 54321 } },
    });
    const database: DatabaseInstance = {
      id: "database",
      service: "database" as const,
      status: Effect.succeed(observation("database", databaseCreation)),
      credentials: () =>
        Effect.succeed({ databaseUrl: "postgresql://postgres@127.0.0.1:54322/postgres" }),
      start: Effect.void,
      ready: Effect.void,
      stop: Effect.void,
      restart: () => Effect.void,
      destroy: Effect.void,
      prepare: Effect.void,
      resetData: Effect.void,
      exportSnapshot: () => Effect.die("unused"),
      restoreSnapshot: () => Effect.die("unused"),
      followStatus: Stream.never,
      logs: Stream.never,
    };
    const functions: FunctionsInstance = {
      id: "functions",
      service: "functions" as const,
      status: Effect.sync(() => observation("functions", functionsCreation())),
      credentials: () => Effect.succeed({ url: "http://127.0.0.1:54321" }),
      start: Deferred.succeed(started, undefined),
      ready: Effect.void,
      stop: Effect.void,
      restart: (input?: Parameters<FunctionsInstance["restart"]>[0]) =>
        Effect.gen(function* () {
          restartCount += 1;
          const first = restartCount === 1;
          if (first && options.restartGate !== undefined) {
            const gate = options.restartGate;
            yield* Deferred.succeed(gate.entered, undefined);
            const pending = yield* Effect.forkIn(
              Effect.gen(function* () {
                yield* Deferred.await(gate.release);
                if (input !== undefined) currentFunctions = input.config;
                yield* Deferred.succeed(gate.mutationDone, undefined);
              }),
              ownerScope,
              { startImmediately: true },
            );
            yield* Fiber.join(pending);
            return;
          }
          if (input !== undefined) currentFunctions = input.config;
          if (restartCount === options.failRestartOn)
            return yield* new StackError({ operation: "restart", message: "restart failed" });
          yield* Deferred.succeed(started, undefined);
        }),
      destroy: Effect.sync(() => {
        destroyed = true;
      }),
      prepare: Effect.void,
      followStatus: Stream.never,
      logs: Stream.never,
    };
    const stack = {
      id: "a".repeat(64),
      services: {
        list: Effect.succeed([database, functions]),
        get: (id: string) => Effect.succeed(id === "database" ? database : functions),
        create: () => Effect.die("unused"),
      },
      composition: {
        describe: Effect.succeed({
          members: [
            { id: "database", activation: "eager" as const },
            { id: "functions", activation: "eager" as const },
          ],
          dependencies: [],
        }),
        supabase: () => Effect.die("unused"),
        configure: () => Effect.die("unused"),
        start: Effect.die("unused"),
        stop: Effect.die("unused"),
        restart: Effect.die("unused"),
      },
      stop: Effect.die("unused"),
      destroy: Effect.die("unused"),
      tools: { run: () => Effect.die("unused") },
    } satisfies Stack;
    const identity = { projectRoot: "/project", branchContext: "main", stackName: "default" };
    const apiService = {
      create: () => Effect.die("unused"),
      open: () => Effect.succeed(stack),
      discover: () =>
        Effect.succeed([
          {
            definition: {
              id: stack.id,
              identity,
              runtime: "native",
              instances: [],
              composition: { members: [], dependencies: [] },
              ports: [],
            },
            host: undefined,
          },
        ]),
      resolveIdentity: () => Effect.succeed(identity),
    } satisfies StackApi["Service"];
    const api = Layer.succeed(StackApi, apiService);
    const layer = Layer.mergeAll(
      BunServices.layer,
      api,
      mockCommandSettings({ workdir: "/project", supabaseHome: "/home" }),
      mockRuntimeInfo({ cwd: "/project", homeDir: "/home" }),
      output.layer,
      signalControl.layer,
      telemetry,
      stackBackendLayer("stack"),
      Layer.succeed(OutputFlag, Option.none()),
    );
    return {
      layer,
      signal,
      started,
      output,
      signalControl,
      get currentFunctions() {
        return currentFunctions;
      },
      get restartCount() {
        return restartCount;
      },
      get destroyed() {
        return destroyed;
      },
    };
  });

describe("experimental Stack Functions serve", () => {
  it.live("restores an overridden composed Functions config on SIGINT", () =>
    Effect.gen(function* () {
      const state = yield* fixture();
      const run = yield* functionsServeStack(flags({ noVerifyJwt: Option.some(true) })).pipe(
        Effect.provide(state.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(state.started);
      expect(state.currentFunctions.verifyJwt).toBe(false);
      yield* Deferred.succeed(state.signal, undefined);
      yield* Fiber.join(run);
      expect(state.currentFunctions.verifyJwt).toBe(true);
      expect(state.restartCount).toBe(2);
    }),
  );

  it.live("merges an explicit env file with saved secrets and restores them on SIGINT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "functions-env-merge-" });
      const file = `${root}/override.env`;
      yield* fs.writeFileString(file, "SHARED=override\nADDED=new\n");
      const state = yield* fixture();
      const run = yield* functionsServeStack(flags({ envFile: Option.some(file) })).pipe(
        Effect.provide(state.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(state.started);
      expect(state.currentFunctions.env).toEqual({
        SHARED: "override",
        RETAINED: "retained",
        ADDED: "new",
      });
      yield* Deferred.succeed(state.signal, undefined);
      yield* Fiber.join(run);
      expect(state.currentFunctions.env).toEqual(functionsConfig().env);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects unsupported flags before reading or mutating the stack", () =>
    Effect.gen(function* () {
      const state = yield* fixture();
      const exit = yield* functionsServeStack(flags({ inspect: true })).pipe(
        Effect.provide(state.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) expect(failure.value.reason).toBe("flags");
      }
      expect(state.restartCount).toBe(0);
      expect(state.destroyed).toBe(false);
    }),
  );

  it.live("restores the saved config when applying an override fails", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ failRestartOn: 1 });
      const exit = yield* functionsServeStack(flags({ noVerifyJwt: Option.some(true) })).pipe(
        Effect.provide(state.layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) expect(failure.value.message).toContain("restart failed");
      }
      expect(state.currentFunctions.verifyJwt).toBe(true);
      expect(state.restartCount).toBe(2);
    }),
  );

  it.live("reports a restore failure and sets the command exit code", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ failRestartOn: 2 });
      const run = yield* functionsServeStack(flags({ noVerifyJwt: Option.some(true) })).pipe(
        Effect.provide(state.layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(state.started);
      yield* Deferred.succeed(state.signal, undefined);
      const result = yield* Fiber.await(run);
      expect(Exit.isSuccess(result)).toBe(true);
      expect(state.signalControl.exitCode).toBe(1);
      expect(
        state.output.rawChunks.some(
          ({ text, stream }) => stream === "stderr" && text.includes("Failed to restore"),
        ),
      ).toBe(true);
    }),
  );
  it.live("rejects multiline environment values before restarting Functions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "functions-env-" });
      const file = `${root}/override.env`;
      yield* fs.writeFileString(file, 'CUSTOM_VALUE="first\nsecond"\n');
      const state = yield* fixture();
      const error = yield* functionsServeStack(flags({ envFile: Option.some(file) })).pipe(
        Effect.provide(state.layer),
        Effect.flip,
      );
      expect(error.reason).toBe("invalid-config");
      expect(error.message).toContain("Multiline");
      expect(state.currentFunctions).toEqual(functionsConfig());
      expect(state.restartCount).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an invalid environment key before restarting Functions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "functions-env-key-" });
      const file = `${root}/override.env`;
      yield* fs.writeFileString(file, "INVALID.KEY=value\n");
      const state = yield* fixture();
      const error = yield* functionsServeStack(flags({ envFile: Option.some(file) })).pipe(
        Effect.provide(state.layer),
        Effect.flip,
      );
      expect(error.message).toContain("Environment names");
      expect(state.currentFunctions).toEqual(functionsConfig());
      expect(state.restartCount).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("restores config when SIGINT arrives during an in-flight restart", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const mutationDone = yield* Deferred.make<void>();
      const state = yield* fixture({ restartGate: { entered, release, mutationDone } });
      const run = yield* functionsServeStack(flags({ noVerifyJwt: Option.some(true) })).pipe(
        Effect.provide(state.layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* Deferred.succeed(state.signal, undefined);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(mutationDone);
      const result = yield* Fiber.await(run);
      expect(Exit.isSuccess(result)).toBe(true);
      expect(state.currentFunctions).toEqual(functionsConfig());
    }),
  );
});
