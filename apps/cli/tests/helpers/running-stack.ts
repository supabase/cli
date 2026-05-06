import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { unixHttpClientLayer } from "@supabase/stack";
import {
  DaemonServer,
  DEFAULT_VERSIONS,
  fullVersionManifest,
  type PartialVersionManifest,
  projectStateManagerPathsFromRoot,
  Stack,
  StackServiceState,
  stackMetadata,
  StateManager,
  type StackInfo,
  type StackMetadata,
  type StackState,
} from "@supabase/stack/effect";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LogEntry,
  ServiceNotFoundError,
} from "../../../../packages/process-compose/src/index.ts";
import { CliConfig } from "../../src/next/config/cli-config.service.ts";
import { ProjectHome } from "../../src/next/config/project-home.service.ts";
import { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";

const DEFAULT_PORTS = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 54323,
  postgrestPort: 54324,
  postgrestAdminPort: 54325,
  edgeRuntimePort: 54337,
  edgeRuntimeInspectorPort: 54338,
  realtimePort: 54326,
  storagePort: 54327,
  imgproxyPort: 54328,
  mailpitPort: 54329,
  mailpitSmtpPort: 54330,
  mailpitPop3Port: 54331,
  pgmetaPort: 54332,
  studioPort: 54333,
  analyticsPort: 54334,
  poolerPort: 54335,
  poolerApiPort: 54336,
};

const DEFAULT_SERVICES: PartialVersionManifest = {
  ...DEFAULT_VERSIONS,
  postgres: "17.6.1.081",
  postgrest: "14.5",
  auth: "2.188.0-rc.15",
  storage: "1.41.8",
};

const DEFAULT_INFO: StackInfo = {
  url: `http://127.0.0.1:${DEFAULT_PORTS.apiPort}`,
  dbUrl: `postgresql://postgres:postgres@127.0.0.1:${DEFAULT_PORTS.dbPort}/postgres`,
  publishableKey: "test-publishable-key",
  secretKey: "test-secret-key",
  anonJwt: "test-anon-jwt",
  serviceRoleJwt: "test-service-role-jwt",
  serviceEndpoints: {
    auth: `http://127.0.0.1:${DEFAULT_PORTS.authPort}`,
  },
};

const DEFAULT_STATES = [
  new StackServiceState({
    name: "auth",
    status: "Healthy",
    pid: 123,
    exitCode: null,
    restartCount: 0,
    startedAt: Date.now(),
    error: null,
  }),
  new StackServiceState({
    name: "postgres",
    status: "Running",
    pid: 456,
    exitCode: null,
    restartCount: 0,
    startedAt: Date.now(),
    error: null,
  }),
];

const DEFAULT_HISTORY: ReadonlyArray<LogEntry> = [
  {
    timestamp: 1_000,
    service: "auth",
    stream: "stdout",
    line: '{"path":"/signup"}',
  },
  {
    timestamp: 1_001,
    service: "postgres",
    stream: "stdout",
    line: "database system is ready to accept connections",
  },
];

function makeProjectHome(projectRoot: string) {
  const projectHomeDir = join(projectRoot, ".supabase");
  return ProjectHome.of({
    projectRoot,
    supabaseDir: join(projectRoot, "supabase"),
    projectHomeDir,
    projectLinkPath: join(projectHomeDir, "project.json"),
    projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
    ensureProjectHomeDir: Effect.void,
    stackDir: (name: string) => join(projectHomeDir, "stacks", name),
    stackStatePath: (name: string) => join(projectHomeDir, "stacks", name, "state.json"),
    stackMetadataPath: (name: string) => join(projectHomeDir, "stacks", name, "stack.json"),
    stackDataDir: (name: string) => join(projectHomeDir, "stacks", name, "data"),
    stackLogsDir: (name: string) => join(projectHomeDir, "stacks", name, "logs"),
  });
}

function makeStackLayer(opts: {
  info: StackInfo;
  states: ReadonlyArray<StackServiceState>;
  history: ReadonlyArray<LogEntry>;
  live: ReadonlyArray<LogEntry>;
  onStop?: () => void;
}) {
  return Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(opts.info),
    start: () => Effect.void,
    stop: () =>
      Effect.sync(() => {
        opts.onStop?.();
      }),
    dispose: () =>
      Effect.sync(() => {
        opts.onStop?.();
      }),
    startService: (name: string) =>
      opts.states.some((state) => state.name === name)
        ? Effect.void
        : Effect.fail(new ServiceNotFoundError({ name })),
    stopService: (name: string) =>
      opts.states.some((state) => state.name === name)
        ? Effect.void
        : Effect.fail(new ServiceNotFoundError({ name })),
    restartService: (name: string) =>
      opts.states.some((state) => state.name === name)
        ? Effect.void
        : Effect.fail(new ServiceNotFoundError({ name })),
    getState: (name: string) => {
      const state = opts.states.find((candidate) => candidate.name === name);
      return state === undefined
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.succeed(state);
    },
    getAllStates: () => Effect.succeed(opts.states),
    stateChanges: (name: string) => {
      const state = opts.states.find((candidate) => candidate.name === name);
      return state === undefined
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.succeed(Stream.make(state));
    },
    allStateChanges: () => Stream.fromIterable(opts.states),
    waitReady: (name: string) =>
      opts.states.some((state) => state.name === name)
        ? Effect.void
        : Effect.fail(new ServiceNotFoundError({ name })),
    waitAllReady: () => Effect.void,
    subscribeLogs: (name: string) =>
      Stream.fromIterable(opts.live.filter((entry) => entry.service === name)),
    subscribeAllLogs: (services?: ReadonlyArray<string>) =>
      Stream.fromIterable(
        services === undefined || services.length === 0
          ? opts.live
          : opts.live.filter((entry) => services.includes(entry.service)),
      ),
    logHistory: (name: string, limit?: number) =>
      Effect.succeed(opts.history.filter((entry) => entry.service === name).slice(-(limit ?? 100))),
    logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) =>
      Effect.succeed(
        (services === undefined || services.length === 0
          ? opts.history
          : opts.history.filter((entry) => services.includes(entry.service))
        ).slice(-(limit ?? 100)),
      ),
  });
}

function spawnAliveProcess(): ChildProcess {
  return spawn("sleep", ["1000"], {
    stdio: "ignore",
  });
}

async function terminateProcess(child: ChildProcess | undefined) {
  if (child?.pid === undefined) {
    return;
  }

  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 200);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function makeStackFixture(
  opts: {
    running?: boolean;
    stackName?: string;
    projectRootName?: string;
    info?: Partial<StackInfo>;
    services?: PartialVersionManifest;
    metadata?: StackMetadata;
    states?: ReadonlyArray<StackServiceState>;
    history?: ReadonlyArray<LogEntry>;
    live?: ReadonlyArray<LogEntry>;
  } = {},
) {
  const rootDir = mkdtempSync(join(tmpdir(), "supabase-cli-running-stack-"));
  const projectRoot = join(rootDir, opts.projectRootName ?? "repo");
  const homeDir = join(rootDir, "home");
  const projectHome = makeProjectHome(projectRoot);
  const socketPath = join(rootDir, "daemon.sock");
  const stackName = opts.stackName ?? "default";
  const running = opts.running ?? true;
  const services = fullVersionManifest({
    ...DEFAULT_SERVICES,
    ...opts.services,
  });
  const info = { ...DEFAULT_INFO, ...opts.info };
  const states = opts.states ?? DEFAULT_STATES;
  const history = opts.history ?? DEFAULT_HISTORY;
  const live = opts.live ?? [];
  let stopped = false;
  let child: ChildProcess | undefined;
  let daemonRuntime: ManagedRuntime.ManagedRuntime<DaemonServer, never> | undefined;

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(projectHome.stackDir(stackName), { recursive: true });

  const metadata =
    opts.metadata ??
    stackMetadata({
      ports: DEFAULT_PORTS,
      services,
      launch: { mode: "auto", excludedServices: [] },
    });

  const stateManagerLayer = StateManager.make(
    projectStateManagerPathsFromRoot(projectHome.projectHomeDir),
  ).pipe(Layer.provide(BunServices.layer));

  if (running) {
    child = spawnAliveProcess();
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("Failed to spawn a child process for the running stack fixture.");
    }

    const state: StackState = {
      pid,
      name: stackName,
      projectDir: projectRoot,
      apiPort: DEFAULT_PORTS.apiPort,
      dbPort: DEFAULT_PORTS.dbPort,
      ports: DEFAULT_PORTS,
      socketPath,
      startedAt: new Date().toISOString(),
      url: info.url,
      dbUrl: info.dbUrl,
      publishableKey: info.publishableKey,
      secretKey: info.secretKey,
      anonJwt: info.anonJwt,
      serviceRoleJwt: info.serviceRoleJwt,
      serviceEndpoints: info.serviceEndpoints,
      services,
    };

    daemonRuntime = ManagedRuntime.make(
      DaemonServer.layer.pipe(
        Layer.provide(
          makeStackLayer({
            info,
            states,
            history,
            live,
            onStop: () => {
              stopped = true;
              if (child !== undefined && child.exitCode == null && child.signalCode == null) {
                child.kill("SIGTERM");
              }
            },
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            BunHttpServer.layer({ idleTimeout: 0, unix: socketPath }),
          ),
        ),
      ),
    );

    await daemonRuntime.runPromise(DaemonServer.asEffect());

    await Effect.runPromise(
      Effect.gen(function* () {
        const stateManager = yield* StateManager;
        yield* stateManager.write(state);
        yield* stateManager.writeMetadata(stackName, metadata);
      }).pipe(Effect.provide(stateManagerLayer)),
    );
  } else {
    await Effect.runPromise(
      Effect.gen(function* () {
        const stateManager = yield* StateManager;
        yield* stateManager.writeMetadata(stackName, metadata);
      }).pipe(Effect.provide(stateManagerLayer)),
    );
  }

  const baseLayer = Layer.mergeAll(
    BunServices.layer,
    unixHttpClientLayer,
    stateManagerLayer,
    Layer.succeed(ProjectHome, projectHome),
    Layer.succeed(
      CliConfig,
      CliConfig.of({
        apiUrl: "https://api.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        projectHost: "supabase.co",
        telemetryPosthogHost: "https://us.i.posthog.com",
        telemetryPosthogKey: "phc_test_key",
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
        arch: "x64",
        homeDir,
        execPath: "/test/bin/bun",
        pid: process.pid,
      }),
    ),
  );

  return {
    projectRoot,
    projectHomeDir: projectHome.projectHomeDir,
    stackName,
    stackStatePath: projectHome.stackStatePath(stackName),
    stackMetadataPath: projectHome.stackMetadataPath(stackName),
    services,
    baseLayer,
    get stopped() {
      return stopped;
    },
    async dispose() {
      if (daemonRuntime !== undefined) {
        await daemonRuntime.dispose();
      }
      await terminateProcess(child);
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export async function makeRunningStackFixture(
  opts: Omit<Parameters<typeof makeStackFixture>[0], "running"> = {},
) {
  return makeStackFixture({ ...opts, running: true });
}

export async function makeStoppedStackFixture(
  opts: Omit<Parameters<typeof makeStackFixture>[0], "running"> = {},
) {
  return makeStackFixture({ ...opts, running: false });
}
