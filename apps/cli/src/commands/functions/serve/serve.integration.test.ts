import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  buildTestRuntime,
  mockCommandPlatformApiService,
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { DebugFlag, NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { StackApi } from "../../../command-internal/stack-api.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { FileWatcher, type FileWatchEvent } from "../../../shared/runtime/file-watcher.service.ts";
import {
  ProcessControl,
  type CliProcessSignal,
} from "../../../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { serveFunctions, type FunctionsServeFlags } from "../../../shared/functions/serve.ts";
import type {
  EffectServiceConfig,
  EffectStack,
  ServiceInstanceId,
  StackDescriptor,
  StackConfig,
  StackLogEntry,
  ServiceStatus,
} from "@supabase/stack/effect";
import { ServiceInstanceIdSchema, StackIdSchema } from "@supabase/stack/effect";

const tempRoot = useTempWorkdir("supabase-functions-serve-managed-");

function baseFlags(overrides: Partial<FunctionsServeFlags> = {}): FunctionsServeFlags {
  return {
    noVerifyJwt: Option.none(),
    envFile: Option.none(),
    importMap: Option.none(),
    inspect: false,
    inspectMode: Option.none(),
    inspectMain: false,
    all: true,
    ...overrides,
  };
}

async function writeProjectConfig(content = 'project_id = "test-project"\n') {
  await mkdir(join(tempRoot.current, "supabase"), { recursive: true });
  await writeFile(join(tempRoot.current, "supabase", "config.toml"), content);
}

async function writeFunction(slug: string, file = "index.ts", content = "export default {}\n") {
  const path = join(tempRoot.current, "supabase", "functions", slug, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function serviceStatus(
  id: ServiceInstanceId,
  phase: "stopped" | "dormant" | "starting" | "ready" | "failed" = "stopped",
) {
  return {
    id,
    service: "functions" as const,
    name: undefined,
    enabled: true,
    intent:
      phase === "stopped" || phase === "dormant" ? ("stopped" as const) : ("started" as const),
    phase,
    activation: "eager" as const,
    endpoints: [],
  };
}

function makeStack(options: {
  fingerprint: string;
  preparedFingerprint?: string;
  prepare?: "normal" | "blocked";
  restart?: "normal" | "blocked";
  logStream?: Stream.Stream<StackLogEntry>;
  logQueue?: Queue.Queue<StackLogEntry>;
  statusQueue?: Queue.Queue<ServiceStatus>;
}) {
  const id = ServiceInstanceIdSchema.make("functions");
  const stackId = StackIdSchema.make("a".repeat(64));
  let phase: "stopped" | "starting" | "ready" = "stopped";
  const starts: number[] = [];
  const restarts: Array<EffectServiceConfig<"functions"> | undefined> = [];
  const preparedConfigs: Array<StackConfig | undefined> = [];
  const prepareStarted = Effect.runSync(Deferred.make<void>());
  const prepareCompleted = Effect.runSync(Deferred.make<void>());
  const started = Effect.runSync(Deferred.make<void>());
  const restarted = Effect.runSync(Deferred.make<void>());
  const restartStarted = Effect.runSync(Deferred.make<void>());
  const subscriptions = { logs: 0, status: 0 };
  const startsBeforeObservation: boolean[] = [];
  const restartsWithObservation: boolean[] = [];

  const descriptor = {
    id,
    service: "functions" as const,
    name: undefined,
    enabled: true,
    config: {
      enabled: true,
      activation: "eager" as const,
      idleTimeoutSeconds: false as const,
      version: "1",
      settings: {},
    },
    dependencies: {},
    snapshotSupport: "unsupported" as const,
    endpoints: {},
    effectiveConfigFingerprint: options.fingerprint,
    data: { origin: "absent" as const },
  };

  const service = {
    id,
    service: "functions" as const,
    name: undefined,
    describe: Effect.succeed(descriptor),
    status: Effect.sync(() => serviceStatus(id, phase)),
    credentials: Effect.succeed({
      publishableKey: "sb_publishable_test",
      secretKey: "sb_secret_test",
      anonJwt: "anon-test",
      serviceRoleJwt: "service-role-test",
    }),
    prepare: Effect.succeed({ instances: [] }),
    start: Effect.gen(function* () {
      startsBeforeObservation.push(subscriptions.logs > 0 && subscriptions.status > 0);
      starts.push(starts.length + 1);
      phase = "ready";
      yield* Deferred.succeed(started, undefined);
      return serviceStatus(id, phase);
    }),
    sleep: Effect.succeed(serviceStatus(id, "stopped")),
    stop: Effect.sync(() => {
      phase = "stopped";
      return serviceStatus(id, phase);
    }),
    restart: (input?: { readonly config?: EffectServiceConfig<"functions"> }) =>
      Effect.gen(function* () {
        restartsWithObservation.push(subscriptions.logs > 0 && subscriptions.status > 0);
        restarts.push(input?.config);
        phase = "ready";
        yield* Deferred.succeed(restartStarted, undefined);
        if (options.restart === "blocked") return yield* Effect.never;
        yield* Deferred.succeed(restarted, undefined);
        return serviceStatus(id, phase);
      }),
    destroy: Effect.void,
    exportSnapshot: () => Effect.die("unexpected snapshot export"),
    restoreSnapshot: () => Effect.die("unexpected snapshot restore"),
    logs: () => Effect.die("unexpected logs query"),
    followLogs: () => {
      subscriptions.logs += 1;
      return (
        options.logStream ??
        (options.logQueue === undefined ? Stream.never : Stream.fromQueue(options.logQueue))
      );
    },
    followStatus: Stream.unwrap(
      Effect.sync(() => {
        subscriptions.status += 1;
        return options.statusQueue === undefined
          ? Stream.never
          : Stream.fromQueue(options.statusQueue);
      }),
    ),
  };

  const stack: EffectStack = {
    id: stackId,
    services: {
      get: () => Effect.succeed(service),
      list: Effect.succeed([descriptor]),
      create: () => Effect.die("unexpected service create"),
    },
    prepare: (input?: {
      readonly services?: ReadonlyArray<string>;
      readonly config?: StackConfig;
    }) =>
      Effect.gen(function* () {
        preparedConfigs.push(input?.config);
        yield* Deferred.succeed(prepareStarted, undefined);
        if (options.prepare === "blocked") return yield* Effect.never;
        yield* Deferred.succeed(prepareCompleted, undefined);
        return {
          instances: [
            {
              id,
              service: "functions" as const,
              artifacts: [],
              effectiveConfigFingerprint: options.preparedFingerprint ?? options.fingerprint,
            },
          ],
          capabilities: [],
        };
      }),
    status: Effect.die("unexpected stack status"),
    followStatus: Stream.never,
    credentials: Effect.die("unexpected stack credentials"),
    start: () => Effect.die("unexpected stack start"),
    sleep: () => Effect.die("unexpected stack sleep"),
    stop: () => Effect.die("unexpected stack stop"),
    restart: () => Effect.die("unexpected stack restart"),
    destroy: () => Effect.die("unexpected stack destroy"),
    logs: () => Effect.die("unexpected stack logs"),
    followLogs: () => Stream.never,
  };

  return {
    stack,
    service,
    starts,
    restarts,
    preparedConfigs,
    prepareStarted,
    prepareCompleted,
    started,
    restarted,
    restartStarted,
    subscriptions,
    startsBeforeObservation,
    restartsWithObservation,
  };
}

function processControl() {
  const signals = Effect.runSync(Queue.unbounded<CliProcessSignal>());
  return {
    layer: Layer.succeed(
      ProcessControl,
      ProcessControl.of({
        awaitSignal: () => Queue.take(signals),
        awaitShutdown: Effect.never,
        holdSignals: () => Effect.void,
        exit: () => Effect.never,
        setExitCode: () => Effect.void,
        getExitCode: Effect.succeed(undefined),
      }),
    ),
    signal: () => Effect.runSync(Queue.offer(signals, "SIGINT")),
  };
}

function fileWatcher() {
  const events = Effect.runSync(Queue.unbounded<ReadonlyArray<FileWatchEvent>>());
  const watched = Effect.runSync(Deferred.make<void>());
  const paths: string[] = [];
  return {
    layer: Layer.succeed(
      FileWatcher,
      FileWatcher.of({
        watch: (path) => {
          paths.push(path);
          Effect.runSync(Deferred.succeed(watched, undefined));
          return Stream.fromQueue(events);
        },
      }),
    ),
    paths,
    watched,
    emit: (event: FileWatchEvent) => Effect.runSync(Queue.offer(events, [event])),
  };
}

function setup(
  stackState: ReturnType<typeof makeStack>,
  control: ReturnType<typeof processControl>,
  watcher = fileWatcher(),
  existingStack = true,
) {
  const out = mockOutput({ format: "text", interactive: false });
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: tempRoot.current });
  const api = mockCommandPlatformApiService({ v1: {} });
  const descriptor: StackDescriptor = {
    id: stackState.stack.id,
    projectRoot: tempRoot.current,
    name: "test",
    branchContext: "main",
    runtime: { kind: "native" },
    desiredLifecycle: "running",
  };
  const stackApi = Layer.succeed(
    StackApi,
    StackApi.of({
      findStack: () => Effect.succeed(existingStack ? Option.some(descriptor) : Option.none()),
      openStack: () => Effect.succeed(stackState.stack),
      createStack: () => Effect.succeed(stackState.stack),
      inspectStack: () => Effect.die("unexpected stack inspect"),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
    }),
  );
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: settings,
      telemetry: telemetry.layer,
      runtimeInfo: mockRuntimeInfo({
        cwd: tempRoot.current,
        homeDir: tempRoot.current,
        platform: "linux",
      }),
      processControl: control,
    }),
    stackApi,
    watcher.layer,
    Layer.succeed(DebugFlag, false),
    Layer.succeed(NetworkIdFlag, Option.none()),
  );
  return { layer, out, watcher };
}

function serve(flags: FunctionsServeFlags) {
  return Effect.gen(function* () {
    const settings = yield* CommandSettings;
    const runtime = yield* RuntimeInfo;
    yield* serveFunctions(flags, {
      projectRoot: settings.workdir,
      supabaseDir: join(settings.workdir, "supabase"),
      flagCwd: runtime.cwd,
      platform: runtime.platform,
      debug: false,
      networkId: Option.none(),
      projectIdOverride: settings.projectId,
      goViperCompat: true,
      goConfigCompat: functionsGoConfigCompat,
    });
  });
}

describe("managed functions serve integration", () => {
  it.live("starts cold without database or auth services and preserves function config", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          'project_id = "test-project"\n\n[functions.disabled]\nenabled = false\n',
        ),
      );
      yield* Effect.promise(() => writeFunction("hello"));
      yield* Effect.promise(() => writeFunction("disabled"));
      const state = makeStack({ fingerprint: "same" });
      const control = processControl();
      const { layer } = setup(state, control, undefined, false);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));
      yield* Deferred.await(state.started);
      control.signal();
      yield* Fiber.join(fiber);

      expect((yield* state.service.status).phase).toBe("ready");
      expect(state.starts).toHaveLength(1);
      expect(state.restarts).toHaveLength(0);
      const config = state.preparedConfigs[0];
      const functionsCapability = config?.capabilities?.functions;
      const settings =
        functionsCapability !== undefined && "settings" in functionsCapability
          ? functionsCapability.settings
          : undefined;
      expect(settings?.functions?.hello?.enabled).toBe(true);
      expect(settings?.functions?.disabled?.enabled).toBe(false);
    }),
  );

  it.live("reuses a ready instance when the prepared effective config is unchanged", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const state = makeStack({ fingerprint: "same" });
      state.service.status = Effect.succeed(serviceStatus(state.service.id, "ready"));
      const control = processControl();
      const { layer } = setup(state, control);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));
      yield* Deferred.await(state.prepareCompleted);
      control.signal();
      yield* Fiber.join(fiber);
      expect(state.starts).toHaveLength(0);
      expect(state.restarts).toHaveLength(0);
    }),
  );

  it.live("restarts the same registered instance when the effective config changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const state = makeStack({ fingerprint: "old", preparedFingerprint: "new" });
      const control = processControl();
      const { layer } = setup(state, control);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));
      yield* Deferred.await(state.prepareCompleted);
      control.signal();
      yield* Fiber.join(fiber);
      expect(state.restarts).toHaveLength(1);
      expect(state.service.id).toBe("functions");
    }),
  );

  it.live("forwards inspector settings and env precedence to the service candidate", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          [
            'project_id = "test-project"',
            "[edge_runtime]",
            "deno_version = 2",
            "[functions.hello]",
            "verify_jwt = true",
            'entrypoint = "./functions/hello/main.ts"',
            'static_files = ["./functions/hello/data.json"]',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeFunction("hello", "main.ts"));
      yield* Effect.promise(() => writeFunction("hello", "data.json", "asset\n"));
      yield* Effect.promise(() =>
        writeFile(join(tempRoot.current, "custom-map.json"), '{"imports":{}}\n'),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "functions", ".env"),
          "SHARED=shared\nTOKEN=shared\n",
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "functions", "hello", ".env"),
          "TOKEN=function\n",
        ),
      );
      const state = makeStack({ fingerprint: "old", preparedFingerprint: "new" });
      const control = processControl();
      const { layer } = setup(state, control);
      const fiber = yield* Effect.forkChild(
        serve(
          baseFlags({
            inspectMode: Option.some("wait"),
            inspectMain: true,
            noVerifyJwt: Option.some(true),
            importMap: Option.some("custom-map.json"),
          }),
        ).pipe(Effect.provide(layer)),
      );
      yield* Deferred.await(state.prepareCompleted);
      control.signal();
      yield* Fiber.join(fiber);
      const config = state.restarts[0];
      const inspectorEndpoint = config?.endpoints?.inspector;
      expect(
        inspectorEndpoint !== undefined && "port" in inspectorEndpoint
          ? inspectorEndpoint.port
          : undefined,
      ).toBe("auto");
      expect(config?.settings?.inspector).toEqual({ mode: "wait", main: true });
      expect(config?.settings?.functions?.hello?.verify_jwt).toBe(false);
      expect(config?.settings?.functions?.hello?.entrypoint).toContain("main.ts");
      expect(config?.settings?.functions?.hello?.import_map).toContain("custom-map.json");
      expect(config?.settings?.functions?.hello?.static_files).toHaveLength(1);
      expect(config?.settings?.edge_runtime?.deno_version).toBe(2);
      const token = config?.settings?.functions?.hello?.env?.TOKEN;
      expect(token === undefined ? undefined : Redacted.value(token)).toBe("function");
      const shared = config?.settings?.functions?.hello?.env?.SHARED;
      expect(shared === undefined ? undefined : Redacted.value(shared)).toBe("shared");
    }),
  );

  it.live("restarts on a source change and rebuilds watcher roots", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const externalName = `${basename(tempRoot.current)}-external.ts`;
      const externalMapName = `${basename(tempRoot.current)}-map.json`;
      const externalPath = join(tempRoot.current, "..", externalName);
      const externalMapPath = join(tempRoot.current, "..", externalMapName);
      yield* Effect.promise(() => writeFile(externalPath, "export const value = 1\n"));
      yield* Effect.promise(() =>
        writeFile(externalMapPath, JSON.stringify({ imports: { external: `./${externalName}` } })),
      );
      const state = makeStack({ fingerprint: "same" });
      const control = processControl();
      const watcher = fileWatcher();
      const { layer } = setup(state, control, watcher);
      const fiber = yield* Effect.forkChild(
        serve(baseFlags({ importMap: Option.some(`../${externalMapName}`) })).pipe(
          Effect.provide(layer),
        ),
      );
      yield* Deferred.await(state.prepareCompleted);
      yield* Deferred.await(watcher.watched);
      const changed = join(tempRoot.current, "supabase", "functions", "hello", "changed.ts");
      yield* Effect.promise(() => writeFunction("hello", "changed.ts"));
      watcher.emit({ path: changed, type: "update" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("600 millis");
      yield* Deferred.await(state.restarted);
      control.signal();
      yield* Fiber.join(fiber);
      expect(state.restarts).toHaveLength(1);
      expect(watcher.paths.length).toBeGreaterThan(1);
      expect(watcher.paths).not.toContain(dirname(externalPath));
      expect(state.subscriptions.logs).toBe(1);
      expect(state.subscriptions.status).toBe(1);
      expect(state.restartsWithObservation).toEqual([true]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("subscribes to the instance before startup and reports a failed runtime", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const statusQueue = yield* Queue.unbounded<ServiceStatus>();
      const state = makeStack({ fingerprint: "same", statusQueue });
      const control = processControl();
      const { layer, out } = setup(state, control);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));

      yield* Deferred.await(state.started);
      expect(state.startsBeforeObservation).toEqual([true]);
      yield* Queue.offer(statusQueue, serviceStatus(state.service.id, "failed"));
      yield* Fiber.join(fiber);

      expect(out.stdoutText).toContain("Edge Runtime container is no longer available");
    }),
  );

  it.live("attaches logs before startup and reports a completed log stream", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const functionsId = ServiceInstanceIdSchema.make("functions");
      const state = makeStack({
        fingerprint: "same",
        logStream: Stream.fromIterable([
          {
            cursor: { opaque: "function-log-1" },
            timestamp: new Date(0).toISOString(),
            source: "functions" as const,
            stream: "stdout" as const,
            message: "function booted\n",
            instanceId: functionsId,
          },
        ]),
      });
      const control = processControl();
      const { layer, out } = setup(state, control);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));

      yield* Deferred.await(state.started);
      yield* Fiber.join(fiber);

      expect(out.stdoutText).toContain("function booted\n");
      expect(out.stdoutText).toContain("Edge Runtime container is no longer available");
      expect(state.subscriptions.logs).toBe(1);
    }),
  );

  it.live("returns on shutdown while a watcher restart is in flight", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const state = makeStack({ fingerprint: "same", restart: "blocked" });
      const control = processControl();
      const watcher = fileWatcher();
      const { layer } = setup(state, control, watcher);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));
      yield* Deferred.await(state.prepareCompleted);
      yield* Deferred.await(watcher.watched);
      const changed = join(tempRoot.current, "supabase", "functions", "hello", "changed.ts");
      yield* Effect.promise(() => writeFunction("hello", "changed.ts"));
      watcher.emit({ path: changed, type: "update" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("600 millis");
      yield* Deferred.await(state.restartStarted);
      control.signal();
      yield* Fiber.join(fiber);
      expect(state.restarts).toHaveLength(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.live("returns on shutdown while startup preparation is blocked", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig());
      yield* Effect.promise(() => writeFunction("hello"));
      const state = makeStack({ fingerprint: "same", prepare: "blocked" });
      const control = processControl();
      const { layer } = setup(state, control);
      const fiber = yield* Effect.forkChild(serve(baseFlags()).pipe(Effect.provide(layer)));
      yield* Deferred.await(state.prepareStarted);
      control.signal();
      yield* Fiber.join(fiber);
      expect(state.service.id).toBe("functions");
    }),
  );
});
