import process from "node:process";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Option, PubSub, Redacted, Stream } from "effect";
import type { ReactElement } from "react";
import type { ProjectConfig, ProjectEnvironment, ProjectPaths } from "@supabase/config";
import {
  NoRunningStackError,
  StateNotFoundError,
  Stack,
  StackServiceState,
  StateManager,
  StackMetadataNotFoundError,
  type StackInfo,
  type StackMetadata,
  type StackState,
} from "@supabase/stack/effect";
import { UnixHttpClient } from "@supabase/stack";
import { Api } from "../../src/auth/api.service.ts";
import type { LoginSessionResponse, ProfileResponse } from "../../src/auth/api.service.ts";
import { Credentials } from "../../src/auth/credentials.service.ts";
import { Crypto } from "../../src/auth/crypto.service.ts";
import { ApiError } from "../../src/auth/errors.ts";
import { cliConfigLayer } from "../../src/config/cli-config.layer.ts";
import { ProjectHome } from "../../src/config/project-home.service.ts";
import {
  ProjectLocalServiceVersions,
  type LocalServiceVersionsState,
} from "../../src/config/project-local-service-versions.service.ts";
import { ProjectLinkRemote } from "../../src/config/project-link-remote.service.ts";
import {
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../src/config/project-link-state.service.ts";
import { ProjectContext } from "../../src/config/project-context.service.ts";
import { NonInteractiveError } from "../../src/output/errors.ts";
import { Output } from "../../src/output/output.service.ts";
import type { OutputFormat } from "../../src/output/types.ts";
import { Browser } from "../../src/runtime/browser.service.ts";
import { Ink, type InkInstance } from "../../src/runtime/ink.service.ts";
import {
  ProcessControl,
  type CliProcessSignal,
} from "../../src/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../src/runtime/runtime-info.service.ts";
import { Stdin } from "../../src/runtime/stdin.service.ts";
import { Tty } from "../../src/runtime/tty.service.ts";
import { Analytics } from "../../src/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../src/telemetry/runtime.service.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutputMessage = {
  type: "intro" | "outro" | "info" | "warn" | "error" | "success" | "fail";
  message: string;
  data?: Record<string, unknown>;
};

type ProgressEvent = {
  type: "start" | "advance" | "message" | "stop";
  message?: string;
  step?: number;
  max?: number;
};

type OutputEvent = {
  type: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Stateless mocks
// ---------------------------------------------------------------------------

export function mockBrowser(): Layer.Layer<Browser> {
  return Layer.succeed(Browser, {
    open: () => Effect.void,
  });
}

export function mockCrypto(token = "sbp_" + "a".repeat(40)): Layer.Layer<Crypto> {
  return Layer.succeed(Crypto, {
    generateKeyPair: Effect.sync(() => ({
      ecdh: {} as import("node:crypto").ECDH,
      publicKeyHex: "04abcd",
    })),
    generateSessionId: Effect.sync(() => "test-session-id"),
    defaultTokenName: Effect.sync(() => "cli_test@host_123"),
    decryptToken: () => Effect.succeed(token),
  });
}

export function mockStdin(isTTY: boolean, pipedInput?: string | Uint8Array): Layer.Layer<Stdin> {
  const pipedBytes =
    pipedInput === undefined
      ? Option.none<Uint8Array>()
      : Option.some(
          typeof pipedInput === "string" ? new TextEncoder().encode(pipedInput) : pipedInput,
        );

  return Layer.succeed(Stdin, {
    isTTY,
    readPipedBytes: Effect.succeed(pipedBytes),
    readPipedText: Effect.succeed(
      Option.isSome(pipedBytes)
        ? Option.some(new TextDecoder().decode(pipedBytes.value))
        : Option.none<string>(),
    ),
  });
}

export function mockTty(
  opts: {
    stdinIsTty?: boolean;
    stdoutIsTty?: boolean;
  } = {},
): Layer.Layer<Tty> {
  return Layer.succeed(Tty, {
    stdinIsTty: opts.stdinIsTty ?? false,
    stdoutIsTty: opts.stdoutIsTty ?? false,
  });
}

export function mockRuntimeInfo(
  opts: {
    cwd?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    homeDir?: string;
    execPath?: string;
    pid?: number;
  } = {},
): Layer.Layer<RuntimeInfo> {
  return Layer.succeed(RuntimeInfo, {
    cwd: opts.cwd ?? "/test/project",
    platform: opts.platform ?? "linux",
    arch: opts.arch ?? "x64",
    homeDir: opts.homeDir ?? "/tmp/supabase-cli-test-home",
    execPath: opts.execPath ?? "/test/bin/bun",
    pid: opts.pid ?? 1234,
  });
}

export function mockProcessControl(
  opts: {
    signal?: CliProcessSignal;
    awaitSignal?: Effect.Effect<CliProcessSignal, never, never>;
    awaitShutdown?: Effect.Effect<void, never, never>;
  } = {},
) {
  let exitCode: number | undefined;
  const exitCalls: number[] = [];

  return {
    layer: Layer.succeed(ProcessControl, {
      awaitSignal: (signals = ["SIGINT", "SIGTERM"]) => {
        if (opts.awaitSignal !== undefined) {
          return opts.awaitSignal;
        }
        if (opts.signal !== undefined && signals.includes(opts.signal)) {
          return Effect.succeed(opts.signal);
        }
        return Effect.never;
      },
      awaitShutdown: opts.awaitShutdown ?? Effect.never,
      exit: (code: number) =>
        Effect.sync(() => {
          exitCalls.push(code);
        }).pipe(Effect.flatMap(() => Effect.never)),
      setExitCode: (code: number) =>
        Effect.sync(() => {
          exitCode = code;
        }),
      getExitCode: Effect.sync(() => exitCode),
    }),
    get exitCalls() {
      return exitCalls;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

// ---------------------------------------------------------------------------
// Stateful mock factories
// ---------------------------------------------------------------------------

export function mockCredentials(opts: { existingToken?: string } = {}) {
  let savedToken: string | undefined;
  let deleteWasCalled = false;
  return {
    layer: Layer.succeed(Credentials, {
      getAccessToken: Effect.sync(() => {
        const token = opts.existingToken ?? savedToken;
        return token ? Option.some(Redacted.make(token)) : Option.none();
      }),
      saveAccessToken: (token: string | Redacted.Redacted<string>) =>
        Effect.sync(() => {
          savedToken = typeof token === "string" ? token : Redacted.value(token);
        }),
      deleteAccessToken: Effect.sync(() => {
        deleteWasCalled = true;
        return !!(opts.existingToken ?? savedToken);
      }),
    }),
    get savedToken() {
      return savedToken;
    },
    get deleteWasCalled() {
      return deleteWasCalled;
    },
  };
}

export function mockOutput(
  opts: {
    format?: OutputFormat;
    interactive?: boolean;
    confirmRelogin?: boolean;
    confirmLogout?: boolean;
    promptTextFail?: boolean;
    promptSelectResponses?: ReadonlyArray<string>;
  } = {},
) {
  const messages: OutputMessage[] = [];
  const progressEvents: ProgressEvent[] = [];
  const events: OutputEvent[] = [];
  const promptSelectCalls: Array<{
    message: string;
    options: ReadonlyArray<{
      value: string;
      label: string;
      hint?: string;
    }>;
    behavior?:
      | {
          mode?: "auto" | "select" | "autocomplete";
          autocompleteThreshold?: number;
          placeholder?: string;
          maxItems?: number;
        }
      | undefined;
  }> = [];
  const promptSelectResponses = [...(opts.promptSelectResponses ?? [])];
  return {
    layer: Layer.succeed(Output, {
      format: opts.format ?? "text",
      interactive: opts.interactive ?? (opts.format ?? "text") === "text",
      intro: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "intro", message });
        }),
      outro: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "outro", message });
        }),
      info: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "info", message });
        }),
      warn: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "warn", message });
        }),
      error: (message: string) =>
        Effect.sync(() => {
          messages.push({ type: "error", message });
        }),
      task: (message: string) =>
        Effect.sync(() => {
          progressEvents.push({ type: "start", message });
          return {
            message: (nextMessage: string) =>
              Effect.sync(() => {
                progressEvents.push({ type: "message", message: nextMessage });
              }),
            succeed: (nextMessage?: string) =>
              Effect.sync(() => {
                if (nextMessage !== undefined) {
                  messages.push({ type: "success", message: nextMessage });
                }
              }),
            fail: (nextMessage?: string) =>
              Effect.sync(() => {
                if (nextMessage !== undefined) {
                  messages.push({ type: "error", message: nextMessage });
                }
              }),
            info: (nextMessage?: string) =>
              Effect.sync(() => {
                if (nextMessage !== undefined) {
                  messages.push({ type: "info", message: nextMessage });
                }
              }),
            cancel: (nextMessage?: string) =>
              Effect.sync(() => {
                if (nextMessage !== undefined) {
                  messages.push({ type: "warn", message: nextMessage });
                }
              }),
            clear: () => Effect.void,
          };
        }),
      event: (event) =>
        Effect.sync(() => {
          events.push(event as OutputEvent);
          messages.push({
            type: "info",
            message:
              event.type === "log-entry"
                ? `[${event.service}] ${event.line}`
                : JSON.stringify(event),
          });
        }),
      success: (message: string, data?: Record<string, unknown>) =>
        Effect.sync(() => {
          messages.push({ type: "success", message, data });
        }),
      fail: (err: { code: string; message: string; detail?: string; suggestion?: string }) =>
        Effect.sync(() => {
          messages.push({ type: "fail", message: err.message });
        }),
      progress: (opts: { max: number }) =>
        Effect.sync(() => ({
          start: (msg: string) =>
            Effect.sync(() => {
              progressEvents.push({ type: "start", message: msg, max: opts.max });
            }),
          advance: (step: number, msg?: string) =>
            Effect.sync(() => {
              progressEvents.push({ type: "advance", step, message: msg });
            }),
          message: (msg: string) =>
            Effect.sync(() => {
              progressEvents.push({ type: "message", message: msg });
            }),
          stop: (msg: string) =>
            Effect.sync(() => {
              progressEvents.push({ type: "stop", message: msg });
            }),
        })),
      promptText: (() => {
        let callCount = 0;
        return (
          _msg: string,
          options?: { defaultValue?: string; validate?: (v: string) => string | undefined },
        ) => {
          callCount++;
          // Exercise the validate callback to cover both branches (line 140)
          if (options?.validate) {
            options.validate(""); // truthy branch: returns error message
            options.validate("123456"); // falsy branch: returns undefined
          }
          // Fail on the verification prompt (2nd call), not the "Press Enter" prompt (1st call)
          if (opts.promptTextFail && callCount > 1) {
            return Effect.fail(
              new NonInteractiveError({
                detail: "Prompt cancelled",
                suggestion: "Run in interactive mode",
              }),
            );
          }
          return Effect.succeed("123456");
        };
      })(),
      promptPassword: () => Effect.succeed(""),
      promptConfirm: () => Effect.succeed(opts.confirmLogout ?? opts.confirmRelogin ?? true),
      promptSelect: (message, options, behavior) =>
        Effect.sync(() => {
          promptSelectCalls.push({ message, options, behavior });
          const response = promptSelectResponses.shift();
          return response ?? options[0]!.value;
        }),
      promptMultiSelect: (_message, options) =>
        Effect.succeed(options.map((option) => option.value)),
    }),
    messages,
    progressEvents,
    events,
    promptSelectCalls,
  };
}

export function mockApi(
  opts: {
    failTimes?: number;
    response?: Partial<LoginSessionResponse>;
    profileResponse?: Partial<ProfileResponse>;
    profileError?: ApiError;
  } = {},
) {
  let callCount = 0;
  let profileCallCount = 0;
  const failTimes = opts.failTimes ?? 0;
  const response: LoginSessionResponse = {
    access_token: "encrypted",
    public_key: "abcd",
    nonce: "1234",
    ...opts.response,
  };
  const profileResponse: ProfileResponse = {
    gotrue_id: "user-123",
    primary_email: "test@example.com",
    username: "tester",
    ...opts.profileResponse,
  };

  return {
    layer: Layer.succeed(Api, {
      fetchLoginSession: () => {
        callCount++;
        if (callCount <= failTimes) {
          return Effect.fail(new ApiError({ detail: "network error" }));
        }
        return Effect.succeed(response);
      },
      fetchProfile: () => {
        profileCallCount++;
        if (opts.profileError !== undefined) {
          return Effect.fail(opts.profileError);
        }
        return Effect.succeed(profileResponse);
      },
    }),
    get callCount() {
      return callCount;
    },
    get profileCallCount() {
      return profileCallCount;
    },
  };
}

export function mockAnalytics() {
  const captured: Array<{
    event: string;
    properties: Record<string, unknown>;
  }> = [];
  const identified: Array<{
    distinctId: string;
    properties: Record<string, unknown>;
  }> = [];
  const aliased: Array<{
    distinctId: string;
    alias: string;
  }> = [];
  const groupIdentified: Array<{
    groupType: string;
    groupKey: string;
    properties: Record<string, unknown>;
  }> = [];

  return {
    layer: Layer.succeed(
      Analytics,
      Analytics.of({
        capture: (event: string, properties: Record<string, unknown> = {}) =>
          Effect.sync(() => {
            captured.push({ event, properties });
          }),
        identify: (distinctId: string, properties: Record<string, unknown> = {}) =>
          Effect.sync(() => {
            identified.push({ distinctId, properties });
          }),
        alias: (distinctId: string, alias: string) =>
          Effect.sync(() => {
            aliased.push({ distinctId, alias });
          }),
        groupIdentify: (
          groupType: string,
          groupKey: string,
          properties: Record<string, unknown> = {},
        ) =>
          Effect.sync(() => {
            groupIdentified.push({ groupType, groupKey, properties });
          }),
      }),
    ),
    captured,
    identified,
    aliased,
    groupIdentified,
  };
}

function mockTelemetryRuntime(
  opts: Partial<{
    configDir: string;
    tracesDir: string;
    consent: "granted" | "denied";
    showDebug: boolean;
    deviceId: string;
    sessionId: string;
    distinctId: string | undefined;
    isFirstRun: boolean;
    isTty: boolean;
    isCi: boolean;
    os: string;
    arch: string;
    cliVersion: string;
  }> = {},
): Layer.Layer<TelemetryRuntime> {
  return Layer.succeed(
    TelemetryRuntime,
    TelemetryRuntime.of({
      configDir: opts.configDir ?? "/tmp/supabase-cli-test-home/.supabase",
      tracesDir: opts.tracesDir ?? "/tmp/supabase-cli-test-home/.supabase/traces",
      consent: opts.consent ?? "granted",
      showDebug: opts.showDebug ?? false,
      deviceId: opts.deviceId ?? "test-device-id",
      sessionId: opts.sessionId ?? "test-session-id",
      distinctId: opts.distinctId,
      isFirstRun: opts.isFirstRun ?? false,
      isTty: opts.isTty ?? false,
      isCi: opts.isCi ?? false,
      os: opts.os ?? "linux",
      arch: opts.arch ?? "x64",
      cliVersion: opts.cliVersion ?? "0.1.0",
    }),
  );
}

export function mockStack(
  opts: {
    info?: Partial<StackInfo>;
    stateChanges?: Array<{ name: string; status: StackServiceState["status"] }>;
    startError?: unknown;
    startPending?: boolean;
    stopPending?: boolean;
    liveStateChanges?: boolean;
  } = {},
) {
  let started = false;
  let stopped = false;
  const startDeferred = Deferred.makeUnsafe<void>();
  const stopDeferred = Deferred.makeUnsafe<void>();
  const stateHistory = [...(opts.stateChanges ?? [])];
  const statePubSub = Effect.runSync(
    PubSub.unbounded<StackServiceState>({
      replay: Math.max(stateHistory.length, 1) + 8,
    }),
  );
  for (const change of stateHistory) {
    PubSub.publishUnsafe(
      statePubSub,
      new StackServiceState({
        name: change.name,
        status: change.status,
        pid: null,
        exitCode: null,
        restartCount: 0,
        startedAt: null,
        error: null,
      }),
    );
  }
  const info: StackInfo = {
    url: "http://127.0.0.1:54321",
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    publishableKey: "test-publishable-key",
    secretKey: "test-secret-key",
    anonJwt: "test-anon-jwt",
    serviceRoleJwt: "test-service-role-jwt",
    serviceEndpoints: {},
    ...opts.info,
  };

  return {
    layer: Layer.succeed(Stack, {
      getInfo: () => Effect.succeed(info),
      start: () =>
        Effect.gen(function* () {
          started = true;
          if (opts.startError !== undefined) {
            return yield* Effect.fail(opts.startError as never);
          }
          if (opts.startPending) {
            yield* Deferred.await(startDeferred);
          }
        }),
      stop: () =>
        Effect.gen(function* () {
          stopped = true;
          if (opts.stopPending) {
            yield* Deferred.await(stopDeferred);
          }
        }),
      dispose: () =>
        Effect.gen(function* () {
          stopped = true;
          if (opts.stopPending) {
            yield* Deferred.await(stopDeferred);
          }
        }),
      startService: () => Effect.void,
      stopService: () => Effect.void,
      restartService: () => Effect.void,
      getState: () =>
        Effect.succeed(
          new StackServiceState({
            name: "postgres",
            status: "Healthy",
            pid: null,
            exitCode: null,
            restartCount: 0,
            startedAt: null,
            error: null,
          }),
        ),
      getAllStates: () => {
        const serviceNames = opts.stateChanges
          ? [...new Set(opts.stateChanges.map((s) => s.name))]
          : ["postgres"];
        return Effect.succeed(
          serviceNames.map(
            (name) =>
              new StackServiceState({
                name,
                status: "Pending",
                pid: null,
                exitCode: null,
                restartCount: 0,
                startedAt: null,
                error: null,
              }),
          ),
        );
      },
      stateChanges: () => Effect.succeed(Stream.empty),
      allStateChanges: () =>
        opts.liveStateChanges
          ? Stream.fromPubSub(statePubSub)
          : opts.stateChanges
            ? Stream.fromIterable(
                opts.stateChanges.map(
                  (change) =>
                    new StackServiceState({
                      name: change.name,
                      status: change.status,
                      pid: null,
                      exitCode: null,
                      restartCount: 0,
                      startedAt: null,
                      error: null,
                    }),
                ),
              )
            : Stream.empty,
      waitReady: () => Effect.void,
      waitAllReady: () => Effect.void,
      subscribeLogs: () => Stream.empty,
      subscribeAllLogs: () => Stream.empty,
      logHistory: () => Effect.succeed([]),
      logHistoryAll: () => Effect.succeed([]),
    }),
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    emitStateChange(change: { name: string; status: StackServiceState["status"] }) {
      stateHistory.push(change);
      PubSub.publishUnsafe(
        statePubSub,
        new StackServiceState({
          name: change.name,
          status: change.status,
          pid: null,
          exitCode: null,
          restartCount: 0,
          startedAt: null,
          error: null,
        }),
      );
    },
    resolveStart() {
      Effect.runSync(Deferred.succeed(startDeferred, void 0));
    },
    resolveStop() {
      Effect.runSync(Deferred.succeed(stopDeferred, void 0));
    },
    info,
  };
}

export function mockInk(opts: { manualExit?: boolean } = {}) {
  let rendered = false;
  let unmounted = false;
  let element: ReactElement | null = null;
  let resolveExit = () => {};
  const exitPromise = new Promise<unknown>((resolve) => {
    resolveExit = () => resolve(undefined);
  });
  return {
    layer: Layer.succeed(Ink, {
      render: (nextElement) =>
        Effect.sync(() => {
          rendered = true;
          element = nextElement;
          return {
            unmount: () => {
              unmounted = true;
            },
            rerender: (updatedElement) => {
              element = updatedElement;
            },
            waitUntilExit: () => (opts.manualExit ? exitPromise : Promise.resolve()),
          } satisfies InkInstance;
        }),
    }),
    get rendered() {
      return rendered;
    },
    get unmounted() {
      return unmounted;
    },
    get element() {
      return element;
    },
    exit() {
      resolveExit();
    },
  };
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function applyProcessEnv(values: Readonly<Record<string, string | undefined>>) {
  const snapshot = { ...process.env };

  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  return snapshot;
}

export function processEnvLayer(
  values: Readonly<Record<string, string | undefined>> = {},
): Layer.Layer<never> {
  return Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => applyProcessEnv(values)),
      (snapshot) =>
        Effect.sync(() => {
          applyProcessEnv(snapshot);
        }),
    ),
  );
}

export function mockProjectContext(
  opts: {
    paths?: Option.Option<ProjectPaths>;
    projectEnv?: Option.Option<ProjectEnvironment>;
    rawProjectConfig?: Option.Option<ProjectConfig>;
  } = {},
): Layer.Layer<ProjectContext> {
  return Layer.succeed(
    ProjectContext,
    ProjectContext.of({
      paths: opts.paths ?? Option.none(),
      projectEnv: opts.projectEnv ?? Option.none(),
      rawProjectConfig: opts.rawProjectConfig ?? Option.none(),
    }),
  );
}

function mockProjectHome(
  opts: {
    projectRoot?: string;
    supabaseDir?: string;
    projectHomeDir?: string;
  } = {},
): Layer.Layer<ProjectHome> {
  const projectRoot = opts.projectRoot ?? "/test/project";
  const supabaseDir = opts.supabaseDir ?? `${projectRoot}/supabase`;
  const projectHomeDir = opts.projectHomeDir ?? `${projectRoot}/.supabase`;

  return Layer.succeed(
    ProjectHome,
    ProjectHome.of({
      projectRoot,
      supabaseDir,
      projectHomeDir,
      projectLinkPath: `${projectHomeDir}/project.json`,
      projectLocalVersionsPath: `${projectHomeDir}/local-versions.json`,
      ensureProjectHomeDir: Effect.void,
      stackDir: (name: string) => `${projectHomeDir}/stacks/${name}`,
      stackStatePath: (name: string) => `${projectHomeDir}/stacks/${name}/state.json`,
      stackMetadataPath: (name: string) => `${projectHomeDir}/stacks/${name}/stack.json`,
      stackDataDir: (name: string) => `${projectHomeDir}/stacks/${name}/data`,
      stackLogsDir: (name: string) => `${projectHomeDir}/stacks/${name}/logs`,
    }),
  );
}

export function mockStateManager(
  opts: {
    states?: ReadonlyArray<StackState>;
    metadata?: ReadonlyArray<{ name: string; metadata: StackMetadata }>;
  } = {},
): Layer.Layer<StateManager> {
  const states = new Map((opts.states ?? []).map((state) => [state.name, state] as const));
  const metadata = new Map((opts.metadata ?? []).map((entry) => [entry.name, entry.metadata]));

  return Layer.succeed(StateManager, {
    stackDir: (name: string) => `/test/project/.supabase/stacks/${name}`,
    dataDir: (name: string) => `/test/project/.supabase/stacks/${name}/data`,
    runtimeDir: (name: string) => `/tmp/supabase/${name}`,
    socketPath: (name: string) => `/tmp/supabase/${name}/daemon.sock`,
    metadataFile: (name: string) => `/test/project/.supabase/stacks/${name}/stack.json`,
    stackExists: (name: string) => Effect.succeed(states.has(name) || metadata.has(name)),
    write: (state: StackState) =>
      Effect.sync(() => {
        states.set(state.name, state);
      }),
    read: (name: string) =>
      Effect.gen(function* () {
        const state = states.get(name);
        if (state === undefined) {
          return yield* Effect.fail(new StateNotFoundError({ name }));
        }
        return state;
      }),
    scan: () => Effect.sync(() => Array.from(states.values())),
    writeMetadata: (name: string, value: StackMetadata) =>
      Effect.sync(() => {
        metadata.set(name, value);
      }),
    updateMetadata: (name: string, update: (value: StackMetadata) => StackMetadata) =>
      Effect.gen(function* () {
        const value = metadata.get(name);
        if (value === undefined) {
          return yield* Effect.fail(new StackMetadataNotFoundError({ name }));
        }
        metadata.set(name, update(value));
      }),
    readMetadata: (name: string) =>
      Effect.gen(function* () {
        const value = metadata.get(name);
        if (value === undefined) {
          return yield* Effect.fail(new StackMetadataNotFoundError({ name }));
        }
        return value;
      }),
    scanMetadata: () => Effect.sync(() => new Map(metadata)),
    remove: (name: string) =>
      Effect.sync(() => {
        states.delete(name);
      }),
    deleteStack: (name: string) =>
      Effect.sync(() => {
        states.delete(name);
        metadata.delete(name);
      }),
    resolve: (cwd: string) =>
      Effect.gen(function* () {
        const state = Array.from(states.values())[0];
        if (state === undefined) {
          return yield* Effect.fail(new NoRunningStackError({ cwd }));
        }
        return state;
      }),
    isAlive: () => Effect.succeed(true),
  });
}

export function mockProjectLinkState(
  initialState?: ProjectLinkStateValue,
): Layer.Layer<ProjectLinkState, never, never> {
  let state = initialState;
  return Layer.succeed(
    ProjectLinkState,
    ProjectLinkState.of({
      load: Effect.sync(() =>
        state === undefined ? Option.none<ProjectLinkStateValue>() : Option.some(state),
      ),
      save: (nextState: ProjectLinkStateValue) =>
        Effect.sync(() => {
          state = nextState;
        }),
      clear: Effect.sync(() => {
        state = undefined;
      }),
      getActiveBranch: Effect.sync(() =>
        state === undefined ? Option.none() : Option.some(state.active_branch),
      ),
      setActiveBranch: (branch) =>
        Effect.sync(() => {
          if (state === undefined) {
            throw new Error("Cannot set active branch: no linked project found.");
          }
          state = { ...state, active_branch: branch };
        }),
    }),
  );
}

export function mockProjectLinkRemote(
  opts: {
    projects?: ReadonlyArray<{
      ref: string;
      name: string;
      region: string;
      status: string;
      organizationId?: string;
      organizationSlug?: string;
    }>;
    linkedProject?: {
      ref: string;
      name: string;
      region: string;
      status: string;
      organizationId?: string;
      organizationSlug?: string;
      versions: {
        postgres?: string;
        postgrest?: string;
        auth?: string;
        storage?: string;
      };
      unavailableServices?: ReadonlyArray<"postgres" | "postgrest" | "auth" | "storage">;
    };
  } = {},
): Layer.Layer<ProjectLinkRemote, never, never> {
  const projects = opts.projects ?? [];
  const linkedProject = opts.linkedProject;
  return Layer.succeed(
    ProjectLinkRemote,
    ProjectLinkRemote.of({
      listAccessibleProjects: Effect.succeed(
        projects.map((project) => ({
          ...project,
          organizationId: project.organizationId ?? "org_123",
          organizationSlug: project.organizationSlug ?? "supabase",
        })),
      ),
      fetchLinkedProject: (projectRef: string) =>
        Effect.gen(function* () {
          if (linkedProject === undefined) {
            return yield* Effect.fail(new Error(`No linked project mock for ${projectRef}`));
          }
          return {
            ...linkedProject,
            organizationId: linkedProject.organizationId ?? "org_123",
            organizationSlug: linkedProject.organizationSlug ?? "supabase",
            unavailableServices: linkedProject.unavailableServices ?? [],
          };
        }),
    }),
  );
}

export function mockProjectLocalServiceVersions(
  initialState?: LocalServiceVersionsState,
): Layer.Layer<ProjectLocalServiceVersions, never, never> {
  let state = initialState;
  return Layer.succeed(
    ProjectLocalServiceVersions,
    ProjectLocalServiceVersions.of({
      load: Effect.sync(() =>
        state === undefined ? Option.none<LocalServiceVersionsState>() : Option.some(state),
      ),
    }),
  );
}

export function emptyEnv() {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer();
  const projectHomeLayer = mockProjectHome();
  const projectLinkStateLayer = mockProjectLinkState();
  const projectLocalServiceVersionsLayer = mockProjectLocalServiceVersions();
  const stateManagerLayer = mockStateManager();
  const analytics = mockAnalytics();
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    projectContextLayer,
    projectHomeLayer,
    projectLinkStateLayer,
    projectLocalServiceVersionsLayer,
    stateManagerLayer,
    analytics.layer,
    mockTelemetryRuntime(),
    envLayer,
    mockTty(),
    mockProcessControl().layer,
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(projectContextLayer)),
    Layer.succeed(UnixHttpClient, {
      request: () => Effect.die("unexpected UnixHttpClient access in tests"),
    }),
  );
}

export function withEnv(env: Record<string, string>) {
  const runtimeInfoLayer = mockRuntimeInfo();
  const projectContextLayer = mockProjectContext();
  const envLayer = processEnvLayer(env);
  const projectHomeLayer = mockProjectHome();
  const stateManagerLayer = mockStateManager();
  const analytics = mockAnalytics();
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    projectContextLayer,
    projectHomeLayer,
    stateManagerLayer,
    analytics.layer,
    mockTelemetryRuntime(),
    envLayer,
    mockTty(),
    mockProcessControl().layer,
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(projectContextLayer)),
  );
}
