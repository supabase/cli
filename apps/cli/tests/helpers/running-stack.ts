import { BunServices } from "@effect/platform-bun";
import {
  Stack,
  StackServiceState,
  StackBuildError,
  type StackInfo,
  httpTransportClientLayer,
} from "@supabase/stack/effect";
import { makeSupervisorControlApplication, SupervisorLifecycle } from "@supabase/stack/testing";
import {
  ManagedStackManager,
  acquireControl,
  controlTransportLayer,
  deriveStackId,
  managedStackManagerLayer,
  type ControlOwnership,
  type ManagedPortIntentDocument,
} from "@supabase/stack/managed";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceNotFoundError } from "@supabase/process-compose";
import { CliConfig } from "../../src/next/config/cli-config.service.ts";
import { ProjectHome } from "../../src/next/config/project-home.service.ts";
import { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";
import { CLI_VERSION } from "../../src/shared/cli/version.ts";

const launch = {
  mode: "docker" as const,
  containerRuntime: "docker" as const,
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

const stackService = (info: StackInfo, onStop: Effect.Effect<void>): Stack["Service"] => ({
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
  options: { running?: boolean; stackName?: string; cliVersion?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "supabase-cli-managed-stack-"));
  const projectRoot = join(root, "repo");
  const homeDir = join(root, "home");
  const stateRoot = join(homeDir, "managed");
  mkdirSync(projectRoot, { recursive: true });
  const stackName = options.stackName ?? "default";
  const running = options.running ?? true;
  const cliVersion = options.cliVersion ?? CLI_VERSION;
  const project = projectHome(projectRoot);
  const managerRuntime = ManagedRuntime.make(
    Layer.mergeAll(managedStackManagerLayer({ stateRoot }), controlTransportLayer),
  );
  const ready = await managerRuntime.runPromise(Deferred.make<void>());
  const daemonReady = await managerRuntime.runPromise(Deferred.make<void>());
  let stackId = "";
  let lifecycleScope: Scope.Scope | undefined;
  const setup = managerRuntime.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* manager.ensureWorkspace(projectRoot);
        stackId = deriveStackId(environment.identity, stackName);
        lifecycleScope = Scope.makeUnsafe();
        const supervisorLifecycle = yield* SupervisorLifecycle.make({
          ownershipId: stackId,
          ownerSessionId: crypto.randomUUID(),
          daemonCliVersion: cliVersion,
          close: Effect.void,
        }).pipe(Effect.provide(Layer.succeed(Scope.Scope, lifecycleScope)));
        let owned: ControlOwnership | undefined;
        const application = {
          app: yield* makeSupervisorControlApplication(supervisorLifecycle, {
            update: (id, next) =>
              owned === undefined
                ? Effect.fail(new StackBuildError({ detail: "fixture owner is not acquired" }))
                : manager.updateLaunch(owned, { stackId: id, launch: next }).pipe(
                    Effect.asVoid,
                    Effect.mapError((error) => new StackBuildError({ detail: String(error) })),
                  ),
          }),
        };
        const ownership = yield* acquireControl({ stackId, application });
        if (ownership._tag !== "Owned") throw new Error("fixture failed to acquire control");
        owned = ownership;
        yield* supervisorLifecycle.setClose(ownership.close);
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
          const runtimeStack = stackService(
            info,
            manager.recordLifecycle(ownership, { stackId, lifecycle: "stopped" }).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          );
          yield* supervisorLifecycle.publishStack(runtimeStack);
          yield* Deferred.await(daemonReady);
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
    await managerRuntime.runPromise(Deferred.succeed(daemonReady, void 0));
  }
  await managerRuntime.runPromise(Deferred.await(ready));

  const baseLayer = Layer.mergeAll(
    BunServices.layer,
    controlTransportLayer,
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
    cliVersion,
    async dispose() {
      await managerRuntime.runPromise(Fiber.interrupt(setup).pipe(Effect.exit));
      await Effect.runPromise(Scope.close(lifecycleScope ?? Scope.makeUnsafe(), Exit.void)).catch(
        () => undefined,
      );
      await managerRuntime.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const makeRunningStackFixture = (
  options: { stackName?: string; cliVersion?: string } = {},
) => makeManagedStackFixture({ ...options, running: true });

export const makeStoppedStackFixture = (
  options: { stackName?: string; cliVersion?: string } = {},
) => makeManagedStackFixture({ ...options, running: false });
