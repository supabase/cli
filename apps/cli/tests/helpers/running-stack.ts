import { BunServices } from "@effect/platform-bun";
import {
  Stack,
  StackServiceState,
  type StackInfo,
  httpTransportClientLayer,
} from "@supabase/stack/effect";
import { DaemonServer } from "@supabase/stack/testing";
import {
  ManagedStackManager,
  deriveStackId,
  managedStackManagerLayer,
  type ControlOwnership,
  type ManagedStackManagerShape,
  type ManagedPortIntentDocument,
} from "@supabase/stack/managed";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceNotFoundError } from "@supabase/process-compose";
import { CliConfig } from "../../src/next/config/cli-config.service.ts";
import { ProjectHome } from "../../src/next/config/project-home.service.ts";
import { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";

const launch = {
  mode: "docker" as const,
  versions: { postgres: "17.6.1" },
  excludedServices: [],
};
const portDocument: ManagedPortIntentDocument = {
  activeFields: ["apiPort", "dbPort"],
  document: {},
};

const stackStates = [
  new StackServiceState({
    name: "postgres",
    status: "Running",
    pid: 123,
    exitCode: null,
    restartCount: 0,
    startedAt: Date.now(),
    error: null,
  }),
];

const history = [
  { timestamp: 1_000, service: "postgres", stream: "stdout" as const, line: "ready" },
];

const stackLayer = (info: StackInfo, onStop: Effect.Effect<void>): Layer.Layer<Stack> =>
  Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(info),
    start: () => Effect.void,
    stop: () => onStop,
    dispose: () => onStop,
    startService: () => Effect.void,
    stopService: () => Effect.void,
    restartService: () => Effect.void,
    reloadFunctions: () => Effect.void,
    reloadEdgeRuntime: () => Effect.void,
    getState: (name: string) => {
      const state = stackStates.find((candidate) => candidate.name === name);
      return state === undefined
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.succeed(state);
    },
    getAllStates: () => Effect.succeed(stackStates),
    stateChanges: (name: string) =>
      Effect.succeed(Stream.fromIterable(stackStates.filter((state) => state.name === name))),
    allStateChanges: () => Stream.fromIterable(stackStates),
    waitReady: () => Effect.void,
    waitAllReady: () => Effect.void,
    subscribeLogs: (name: string) =>
      Stream.fromIterable(history.filter((entry) => entry.service === name)),
    subscribeAllLogs: () => Stream.fromIterable(history),
    logHistory: (name: string, limit?: number) =>
      Effect.succeed(history.filter((entry) => entry.service === name).slice(-(limit ?? 100))),
    logHistoryAll: (limit?: number) => Effect.succeed(history.slice(-(limit ?? 100))),
  });

function projectHome(projectRoot: string): ProjectHome["Service"] {
  const projectHomeDir = join(projectRoot, ".supabase");
  return ProjectHome.of({
    projectRoot,
    supabaseDir: join(projectRoot, "supabase"),
    projectHomeDir,
    projectLinkPath: join(projectHomeDir, "project.json"),
    projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
    ensureProjectHomeDir: Effect.void,
  });
}

export async function makeManagedStackFixture(
  options: { running?: boolean; stackName?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "supabase-cli-managed-stack-"));
  const projectRoot = join(root, "repo");
  const homeDir = join(root, "home");
  const stateRoot = join(homeDir, "managed");
  mkdirSync(projectRoot, { recursive: true });
  const stackName = options.stackName ?? "default";
  const running = options.running ?? true;
  const project = projectHome(projectRoot);
  const managerRuntime = ManagedRuntime.make(managedStackManagerLayer({ stateRoot }));
  const ready = await managerRuntime.runPromise(Deferred.make<void>());
  const ownerReady = await managerRuntime.runPromise(
    Deferred.make<{
      ownership: ControlOwnership;
      info: StackInfo;
      manager: ManagedStackManagerShape;
    }>(),
  );
  const daemonReady = await managerRuntime.runPromise(Deferred.make<void>());
  let stackId = "";
  let daemonRuntime: ManagedRuntime.ManagedRuntime<DaemonServer, never> | undefined;
  const setup = managerRuntime.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* manager.ensureWorkspace(projectRoot);
        stackId = deriveStackId(environment.identity, stackName);
        const ownership = yield* manager.acquireControl(stackId);
        if (ownership._tag !== "Owned") throw new Error("fixture failed to acquire control");
        const started = yield* manager.startStack({
          workspacePath: projectRoot,
          stackName,
          portDocument,
          ownership,
          lifecycle: running ? "running" : "stopped",
          runtime: running
            ? { pid: process.pid, controlEndpoint: ownership.endpoint.url, protocolVersion: 1 }
            : undefined,
          launch,
        });
        const apiPort = started.stack.ports.find(
          (assignment) => assignment.key === "api.port",
        )?.port;
        const dbPort = started.stack.ports.find((assignment) => assignment.key === "db.port")?.port;
        if (apiPort === undefined || dbPort === undefined)
          throw new Error("fixture missing core ports");
        const info: StackInfo = {
          url: `http://127.0.0.1:${apiPort}`,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
          publishableKey: "test-publishable-key",
          secretKey: "test-secret-key",
          anonJwt: "test-anon-jwt",
          serviceRoleJwt: "test-service-role-jwt",
          serviceEndpoints: {},
        };
        if (running) {
          yield* Deferred.succeed(ownerReady, { ownership, info, manager });
          yield* Deferred.await(daemonReady);
          yield* ownership.setState("running", true);
        } else {
          yield* ownership.close;
        }
        yield* Deferred.succeed(ready, void 0);
        yield* Effect.succeed(started);
        yield* Effect.never;
      }),
    ),
  );
  if (running) {
    const owner = await managerRuntime.runPromise(Deferred.await(ownerReady));
    const daemonLayer = DaemonServer.layerWithShutdown(
      Effect.forkDetach(Effect.sleep("50 millis").pipe(Effect.andThen(owner.ownership.close))).pipe(
        Effect.asVoid,
      ),
      owner.ownership.ownerStatus,
      {
        includeOwnerRoute: false,
        launchUpdate: (next) =>
          owner.manager
            .updateLaunch(owner.ownership, { stackId, launch: next })
            .pipe(Effect.asVoid),
      },
    ).pipe(
      Layer.provide(
        stackLayer(
          owner.info,
          owner.manager.recordLifecycle(owner.ownership, { stackId, lifecycle: "stopped" }).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          ),
        ),
      ),
      Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.ownership.server)),
    );
    daemonRuntime = ManagedRuntime.make(daemonLayer);
    await daemonRuntime.runPromise(DaemonServer);
    await managerRuntime.runPromise(Deferred.succeed(daemonReady, void 0));
  }
  await managerRuntime.runPromise(Deferred.await(ready));

  const baseLayer = Layer.mergeAll(
    BunServices.layer,
    httpTransportClientLayer,
    Layer.succeed(ProjectHome, project),
    Layer.succeed(
      CliConfig,
      CliConfig.of({
        apiUrl: "https://api.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        projectHost: "supabase.co",
        telemetryPosthogHost: "https://us.i.posthog.com",
        telemetryPosthogKey: Option.none(),
        accessToken: Option.none(),
        noKeyring: Option.none(),
        supabaseHome: homeDir,
        debug: Option.none(),
        telemetryDebug: Option.none(),
        telemetryDisabled: Option.none(),
        doNotTrack: Option.none(),
      }),
    ),
    Layer.succeed(
      RuntimeInfo,
      RuntimeInfo.of({
        cwd: projectRoot,
        platform: "darwin",
        arch: "arm64",
        homeDir,
        execPath: "/test/bin/bun",
        pid: process.pid,
      }),
    ),
  );

  return {
    projectRoot,
    homeDir,
    stateRoot,
    stackName,
    stackId,
    baseLayer,
    stackInfo: await managerRuntime.runPromise(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const document = yield* manager.inspectStack(stackId);
        const apiPort = document?.ports.find((assignment) => assignment.key === "api.port")?.port;
        const dbPort = document?.ports.find((assignment) => assignment.key === "db.port")?.port;
        if (apiPort === undefined || dbPort === undefined)
          throw new Error("fixture missing core ports");
        return {
          url: `http://127.0.0.1:${apiPort}`,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
          publishableKey: "test-publishable-key",
          secretKey: "test-secret-key",
          anonJwt: "test-anon-jwt",
          serviceRoleJwt: "test-service-role-jwt",
          serviceEndpoints: {},
        } satisfies StackInfo;
      }),
    ),
    readDocument: () =>
      managerRuntime.runPromise(
        Effect.gen(function* () {
          const manager = yield* ManagedStackManager;
          return yield* manager.inspectStack(stackId);
        }),
      ),
    launch,
    async dispose() {
      await managerRuntime.runPromise(Fiber.interrupt(setup));
      await daemonRuntime?.dispose();
      await managerRuntime.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const makeRunningStackFixture = (options: { stackName?: string } = {}) =>
  makeManagedStackFixture({ ...options, running: true });

export const makeStoppedStackFixture = (options: { stackName?: string } = {}) =>
  makeManagedStackFixture({ ...options, running: false });
