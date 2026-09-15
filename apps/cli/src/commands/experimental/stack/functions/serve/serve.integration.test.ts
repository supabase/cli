// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Stream,
} from "effect";
import {
  StackCleanupError,
  StackIdSchema,
  StackNotRunningError,
  StackRuntimeError,
  type EffectStack,
  type ServeFunctionsOptions,
  type StackStatus,
} from "@supabase/stack/effect";
import { candidateDotenvFilenames } from "../../../../../command-internal/project-environment.ts";
import { DebugFlag } from "../../../../../command-internal/global-flags.ts";
import { serveFileWatcherLayer } from "../../../../../shared/functions/serve.ts";
import {
  FileWatcher,
  type FileWatchEvent,
} from "../../../../../shared/runtime/file-watcher.service.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../../../tests/helpers/mocks.ts";
import { StackApi } from "../../stack.shared.ts";
import { functionsServeStack } from "./serve.handler.ts";
import { StackFunctionsServeError } from "./serve.errors.ts";

const id = StackIdSchema.make("f".repeat(64));
const flags: Parameters<typeof functionsServeStack>[0] = {
  noVerifyJwt: Option.none(),
  envFile: Option.none(),
  importMap: Option.none(),
  inspect: false,
  inspectMode: Option.none(),
  inspectMain: false,
  all: true,
};

const status: StackStatus = {
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {
    api: {
      protocol: "http",
      address: "127.0.0.1",
      port: 54321,
      url: "http://127.0.0.1:54321",
    },
  },
  versions: {},
  capabilities: [],
  artifacts: [],
};

const stoppedStatus: StackStatus = {
  ...status,
  lifecycle: "stopped",
  desiredLifecycle: "stopped",
  endpoints: {},
};

const silentFileWatcherLayer = Layer.succeed(FileWatcher, {
  watch: () => Stream.never,
});

const descriptorFor = (projectRoot: string) => ({
  id,
  projectRoot,
  name: "serve-test",
  branchContext: "ordinary-workspace" as const,
  runtime: { kind: "native" as const },
  desiredLifecycle: "running" as const,
});

const stackApiLayer = (projectRoot: string, stack: EffectStack) =>
  Layer.succeed(StackApi, {
    findStack: () => Effect.succeed(Option.some(descriptorFor(projectRoot))),
    openStack: () => Effect.succeed(stack),
    createStack: () => Effect.die("must not create"),
    inspectStack: () => Effect.die("must not inspect"),
    discoverStacks: () => Effect.die("must not discover"),
  });

const makeProject = (prefix: string) => {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(projectRoot, "supabase", "functions", "hello"), { recursive: true });
  writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "serve-test"\n');
  writeFileSync(
    join(projectRoot, "supabase", "functions", "hello", "index.ts"),
    'Deno.serve(() => new Response("hello"))\n',
  );
  return projectRoot;
};

describe("managed stack functions serve", () => {
  it.live("serves on the current managed stack and leaves it running on interruption", () =>
    Effect.gen(function* () {
      const projectRoot = mkdtempSync(join(tmpdir(), "supabase-stack-functions-serve-"));
      mkdirSync(join(projectRoot, "supabase", "functions", "hello"), { recursive: true });
      writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "serve-test"\n');
      writeFileSync(
        join(projectRoot, "supabase", "functions", "hello", "index.ts"),
        'Deno.serve(() => new Response("hello"))\n',
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const activated = yield* Deferred.make<void>();
      const servedRequests: ServeFunctionsOptions[] = [];
      let stopCalls = 0;
      let destroyCalls = 0;
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) =>
          Effect.sync(() => {
            servedRequests.push(options ?? {});
          }).pipe(
            Effect.andThen(
              options?.waitForTermination === true ? Effect.never : Effect.succeed(status),
            ),
          ),
        stop: Effect.sync(() => void stopCalls++),
        destroy: Effect.sync(() => void destroyCalls++),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () =>
          Stream.fromEffect(Deferred.succeed(activated, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          ),
      };
      const descriptor = {
        id,
        projectRoot,
        name: "serve-test",
        branchContext: "ordinary-workspace" as const,
        runtime: { kind: "native" as const },
        desiredLifecycle: "running" as const,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        serveFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        Layer.succeed(StackApi, {
          findStack: () => Effect.succeed(Option.some(descriptor)),
          openStack: () => Effect.succeed(stack),
          createStack: () => Effect.die("must not create"),
          inspectStack: () => Effect.die("must not inspect"),
          discoverStacks: () => Effect.die("must not discover"),
        }),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack(flags).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(activated);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Fiber.join(fiber);
      expect(servedRequests).toHaveLength(3);
      expect(servedRequests[0]?.config).toBeDefined();
      expect(servedRequests[1]?.waitForTermination).toBe(true);
      expect(servedRequests[2]?.config).toBeUndefined();
      const sessionIds = servedRequests.map(({ sessionId }) => sessionId);
      expect(sessionIds[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
      expect(new Set(sessionIds).size).toBe(1);
      expect(stopCalls).toBe(0);
      expect(destroyCalls).toBe(0);
      expect(output.stderrText).toContain("Setting up Edge Functions runtime");
      expect(output.stdoutText).toContain("http://127.0.0.1:54321/functions/v1/<function-name>");
      expect(output.stdoutText).toContain("Stopped serving supabase/functions");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("guides users to start the stack when none is selected", () =>
    Effect.gen(function* () {
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const failure = yield* functionsServeStack(flags).pipe(
        Effect.provide(
          Layer.mergeAll(
            output.layer,
            telemetry.layer,
            mockCommandSettings({ workdir: "/project" }),
            mockRuntimeInfo({ cwd: "/project" }),
            mockProcessControl({ signal: "SIGINT" }).layer,
            serveFileWatcherLayer,
            Layer.succeed(DebugFlag, false),
            Layer.succeed(StackApi, {
              findStack: () => Effect.succeed(Option.none()),
              openStack: () => Effect.die("must not open"),
              createStack: () => Effect.die("must not create"),
              inspectStack: () => Effect.die("must not inspect"),
              discoverStacks: () => Effect.die("must not discover"),
            }),
            BunServices.layer,
          ),
        ),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(StackFunctionsServeError);
      if (!(failure instanceof StackFunctionsServeError)) return;
      expect(failure.suggestion).toContain("supabase start");
      expect(telemetry.flushed).toBe(true);
    }),
  );

  it.live("reloads invocation inputs after a watched Function change", () =>
    Effect.gen(function* () {
      const projectRoot = mkdtempSync(join(tmpdir(), "supabase-stack-functions-reload-"));
      const functionsRoot = join(projectRoot, "supabase", "functions");
      mkdirSync(join(functionsRoot, "hello"), { recursive: true });
      writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "serve-test"\n');
      writeFileSync(
        join(functionsRoot, "hello", "index.ts"),
        'Deno.serve(() => new Response("hello"))\n',
      );
      const envPath = join(projectRoot, "serve.env");
      writeFileSync(envPath, "MARKER=first\n");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));

      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const changes = yield* Queue.unbounded<ReadonlyArray<FileWatchEvent>>();
      const activated = yield* Deferred.make<void>();
      const activations = yield* Deferred.make<void>();
      const servedRequests: ServeFunctionsOptions[] = [];
      let activationCount = 0;
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) =>
          Effect.sync(() => {
            servedRequests.push(options ?? {});
            if (options?.config !== undefined) activationCount++;
            return activationCount;
          }).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(activated, undefined)
                : count === 2
                  ? Deferred.succeed(activations, undefined)
                  : Effect.void,
            ),
            Effect.flatMap(() =>
              options?.waitForTermination === true ? Effect.never : Effect.succeed(status),
            ),
          ),
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const descriptor = {
        id,
        projectRoot,
        name: "serve-test",
        branchContext: "ordinary-workspace" as const,
        runtime: { kind: "native" as const },
        desiredLifecycle: "running" as const,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        Layer.succeed(DebugFlag, false),
        Layer.succeed(FileWatcher, {
          watch: (root) => (root === functionsRoot ? Stream.fromQueue(changes) : Stream.never),
        }),
        Layer.succeed(StackApi, {
          findStack: () => Effect.succeed(Option.some(descriptor)),
          openStack: () => Effect.succeed(stack),
          createStack: () => Effect.die("must not create"),
          inspectStack: () => Effect.die("must not inspect"),
          discoverStacks: () => Effect.die("must not discover"),
        }),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack({
        ...flags,
        envFile: Option.some("serve.env"),
      }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(activated);
      writeFileSync(envPath, "MARKER=second\n");
      yield* Queue.offer(changes, [
        { path: join(functionsRoot, "hello", "index.ts"), type: "update" },
      ]);
      yield* Deferred.await(activations);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Fiber.join(fiber);

      const activationsOnly = servedRequests.filter(({ config }) => config !== undefined);
      expect(activationsOnly).toHaveLength(2);
      expect(servedRequests.some(({ waitForTermination }) => waitForTermination)).toBe(true);
      expect(servedRequests.at(-1)?.config).toBeUndefined();
      expect(servedRequests.at(-1)?.waitForTermination).toBeUndefined();
      expect(new Set(servedRequests.map(({ sessionId }) => sessionId)).size).toBe(1);
      const first = activationsOnly[0]?.config as {
        capabilities?: {
          functions?: {
            settings?: {
              edge_runtime?: { secrets?: Record<string, Redacted.Redacted<string>> };
            };
          };
        };
      };
      const second = activationsOnly[1]?.config as typeof first;
      const firstMarker = first.capabilities?.functions?.settings?.edge_runtime?.secrets?.MARKER;
      const secondMarker = second.capabilities?.functions?.settings?.edge_runtime?.secrets?.MARKER;
      expect(firstMarker === undefined ? undefined : Redacted.value(firstMarker)).toBe("first");
      expect(secondMarker === undefined ? undefined : Redacted.value(secondMarker)).toBe("second");
      expect(output.stderrText).toContain("File change detected:");
    }).pipe(Effect.scoped),
  );

  it.live("reloads when a selected project dotenv file is created", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-dotenv-reload-");
      writeFileSync(
        join(projectRoot, "supabase", "config.toml"),
        'project_id = "serve-test"\n[functions.hello]\nenv = { MARKER = "env(RELOAD_MARKER)" }\n',
      );
      writeFileSync(join(projectRoot, ".env"), "RELOAD_MARKER=first\n");
      const configuredEnvironment = yield* Config.string("SUPABASE_ENV").pipe(
        Config.withDefault("development"),
      );
      const selectedDotenv = join(
        projectRoot,
        candidateDotenvFilenames(configuredEnvironment || "development")[0]!,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));

      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const changes = yield* Queue.unbounded<ReadonlyArray<FileWatchEvent>>();
      const activated = yield* Deferred.make<void>();
      const reloaded = yield* Deferred.make<void>();
      const markers: string[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          if (options?.waitForTermination === true) return Effect.never;
          if (options?.config === undefined) return Effect.succeed(status);
          const functions = options.config.capabilities?.functions;
          const marker =
            functions !== undefined && "settings" in functions
              ? functions.settings?.functions?.hello?.env?.MARKER
              : undefined;
          if (marker !== undefined) markers.push(Redacted.value(marker));
          return (
            markers.length === 1
              ? Deferred.succeed(activated, undefined)
              : markers.length === 2
                ? Deferred.succeed(reloaded, undefined)
                : Effect.void
          ).pipe(Effect.as(status));
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        Layer.succeed(FileWatcher, {
          watch: (root) => (root === projectRoot ? Stream.fromQueue(changes) : Stream.never),
        }),
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack(flags).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(activated);
      writeFileSync(selectedDotenv, "RELOAD_MARKER=second\n");
      yield* Queue.offer(changes, [{ path: selectedDotenv, type: "create" }]);
      yield* Deferred.await(reloaded);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Fiber.join(fiber);

      expect(markers).toEqual(["first", "second"]);
      expect(output.stderrText).toContain(`File change detected: ${selectedDotenv} (CREATE)`);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("restores the durable activation when interrupted during pending activation", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-pending-");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const activationEntered = yield* Deferred.make<void>();
      const restored = yield* Deferred.make<void>();
      const events: string[] = [];
      const servedRequests: ServeFunctionsOptions[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          servedRequests.push(options ?? {});
          if (options?.config !== undefined) {
            return Effect.sync(() => events.push("activation-started")).pipe(
              Effect.andThen(Deferred.succeed(activationEntered, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          if (options?.waitForTermination === true) return Effect.never;
          return Effect.sync(() => events.push("restored")).pipe(
            Effect.andThen(Deferred.succeed(restored, undefined)),
            Effect.as(status),
          );
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        silentFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack(flags).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(activationEntered);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Deferred.await(restored);
      yield* Fiber.join(fiber);

      expect(events).toEqual(["activation-started", "restored"]);
      expect(servedRequests).toHaveLength(2);
      expect(servedRequests[1]).toEqual({ sessionId: servedRequests[0]?.sessionId });
      expect(output.stdoutText).toContain("Stopped serving supabase/functions");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("fails when Functions terminates while the stack remains running", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-crash-");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const servedRequests: ServeFunctionsOptions[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          servedRequests.push(options ?? {});
          if (options?.waitForTermination === true)
            return Effect.fail(new StackRuntimeError({ message: "functions runtime crashed" }));
          return Effect.succeed(status);
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Effect.never }).layer,
        silentFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      const result = yield* functionsServeStack(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).toContain("functions runtime crashed");
      expect(servedRequests).toHaveLength(3);
      expect(servedRequests.at(-1)).toEqual({ sessionId: servedRequests[0]?.sessionId });
      expect(telemetry.flushed).toBe(true);
    }),
  );

  it.live("exits cleanly without restoring after the managed stack stops externally", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-external-stop-");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const servedRequests: ServeFunctionsOptions[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          servedRequests.push(options ?? {});
          return Effect.succeed(options?.waitForTermination === true ? stoppedStatus : status);
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Effect.never }).layer,
        silentFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      yield* functionsServeStack(flags).pipe(Effect.provide(layer));
      expect(servedRequests).toHaveLength(2);
      expect(servedRequests[0]?.config).toBeDefined();
      expect(servedRequests[1]?.waitForTermination).toBe(true);
      expect(output.stdoutText).toContain("Stopped serving supabase/functions");
      expect(telemetry.flushed).toBe(true);
    }),
  );

  it.live("handles an external stop committed before the termination wait is admitted", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-stop-race-");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const servedRequests: ServeFunctionsOptions[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(stoppedStatus),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          servedRequests.push(options ?? {});
          if (options?.waitForTermination === true)
            return Effect.fail(new StackNotRunningError({ message: "stack already stopped" }));
          return Effect.succeed(status);
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Effect.never }).layer,
        silentFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      yield* functionsServeStack(flags).pipe(Effect.provide(layer));
      expect(servedRequests).toHaveLength(2);
      expect(servedRequests[0]?.config).toBeDefined();
      expect(servedRequests[1]?.waitForTermination).toBe(true);
      expect(output.stdoutText).toContain("Stopped serving supabase/functions");
      expect(telemetry.flushed).toBe(true);
    }),
  );

  it.live("reports both the primary runtime failure and a restore failure", () =>
    Effect.gen(function* () {
      const projectRoot = makeProject("supabase-stack-functions-restore-failure-");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) => {
          if (options?.config !== undefined) return Effect.succeed(status);
          if (options?.waitForTermination === true)
            return Effect.fail(new StackRuntimeError({ message: "primary runtime failure" }));
          return Effect.fail(new StackCleanupError({ message: "durable restore failure" }));
        },
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Effect.never }).layer,
        silentFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        stackApiLayer(projectRoot, stack),
        BunServices.layer,
      );

      const result = yield* functionsServeStack(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const rendered = Cause.pretty(result.cause);
        expect(rendered).toContain("primary runtime failure");
        expect(rendered).toContain("durable restore failure");
      }
      expect(telemetry.flushed).toBe(true);
    }),
  );
});
