import { ConfigProvider, Deferred, Effect, Layer, Option, PubSub, Stream } from "effect";
import type { ReactElement } from "react";
import { StackServiceState } from "@supabase/stack";
import { Stack, type StackInfo } from "@supabase/stack/internals";
import { Api } from "../../src/auth/api.service.ts";
import type { LoginSessionResponse } from "../../src/auth/api.service.ts";
import { Credentials } from "../../src/auth/credentials.service.ts";
import { Crypto } from "../../src/auth/crypto.service.ts";
import { ApiError } from "../../src/auth/errors.ts";
import { cliConfigLayer } from "../../src/config/cli-config.layer.ts";
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

export function mockStdin(isTTY: boolean, pipedToken?: string): Layer.Layer<Stdin> {
  return Layer.succeed(Stdin, {
    isTTY,
    readPipedToken: Effect.succeed(pipedToken ? Option.some(pipedToken) : Option.none()),
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
    homeDir: opts.homeDir ?? "/test/home",
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
  return {
    layer: Layer.succeed(Credentials, {
      getAccessToken: Effect.sync(() => {
        const token = opts.existingToken ?? savedToken;
        return token ? Option.some(token) : Option.none();
      }),
      saveAccessToken: (token: string) =>
        Effect.sync(() => {
          savedToken = token;
        }),
    }),
    get savedToken() {
      return savedToken;
    },
  };
}

export function mockOutput(
  opts: {
    format?: OutputFormat;
    interactive?: boolean;
    confirmRelogin?: boolean;
    promptTextFail?: boolean;
  } = {},
) {
  const messages: OutputMessage[] = [];
  const progressEvents: ProgressEvent[] = [];
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
      event: (event) =>
        Effect.sync(() => {
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
      promptConfirm: () => Effect.succeed(opts.confirmRelogin ?? true),
    }),
    messages,
    progressEvents,
  };
}

export function mockApi(opts: { failTimes?: number } = {}) {
  let callCount = 0;
  const failTimes = opts.failTimes ?? 0;
  const response: LoginSessionResponse = {
    access_token: "encrypted",
    public_key: "abcd",
    nonce: "1234",
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
    }),
    get callCount() {
      return callCount;
    },
  };
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
    dockerContainerNames: [],
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

export function emptyEnv() {
  const configProviderLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
  const runtimeInfoLayer = mockRuntimeInfo();
  return Layer.mergeAll(
    configProviderLayer,
    runtimeInfoLayer,
    mockTty(),
    mockProcessControl().layer,
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(configProviderLayer)),
  );
}

export function withEnv(env: Record<string, string>) {
  const configProviderLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env }));
  const runtimeInfoLayer = mockRuntimeInfo();
  return Layer.mergeAll(
    configProviderLayer,
    runtimeInfoLayer,
    mockTty(),
    mockProcessControl().layer,
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(configProviderLayer)),
  );
}
