import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Option, Redacted, Stream } from "effect";
import type { CliProjectEnvironment, CliProjectPaths } from "@supabase/config";
import { Api } from "../../src/next/auth/api.service.ts";
import type { LoginSessionResponse, ProfileResponse } from "../../src/next/auth/api.service.ts";
import { Credentials } from "../../src/next/auth/credentials.service.ts";
import { Crypto } from "../../src/next/auth/crypto.service.ts";
import { ApiError } from "../../src/next/auth/errors.ts";
import { cliSettingsLayer } from "../../src/next/config/cli-settings.layer.ts";
import { CliProjectHome } from "../../src/next/config/cli-project-home.service.ts";
import {
  CliProjectLocalServiceVersions,
  type LocalServiceVersionsState,
} from "../../src/next/config/cli-project-local-service-versions.service.ts";
import { ProjectLinkRemote } from "../../src/next/config/project-link-remote.service.ts";
import {
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../src/next/config/project-link-state.service.ts";
import { CliProjectContext } from "../../src/next/config/cli-project-context.service.ts";
import { NonInteractiveError } from "../../src/shared/output/errors.ts";
import { Output } from "../../src/shared/output/output.service.ts";
import type { OutputFormat } from "../../src/shared/output/types.ts";
import { Browser } from "../../src/shared/runtime/browser.service.ts";
import {
  ProcessControl,
  type CliProcessSignal,
} from "../../src/shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../src/shared/runtime/stdin.service.ts";
import { Tty } from "../../src/shared/runtime/tty.service.ts";
import { Analytics } from "../../src/shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../src/shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../src/shared/telemetry/identity.ts";

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

// Default home for mocks that need *some* path value. Unique per process (never
// created on disk here) so a test that accidentally combines this default with a
// real FileSystem layer can never pick up stale files written by earlier test
// runs or manual CLI invocations — the failure mode the previous fixed literal
// `/tmp/supabase-cli-test-home` allowed. Tests that really read or write files
// under homeDir must pass their own per-test temp dir instead (see
// `useLegacyTempWorkdir` in `legacy-mocks.ts`).
const defaultTestHomeDir = join(
  tmpdir(),
  `supabase-cli-test-home-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
);

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

  const pipedText = Option.isSome(pipedBytes)
    ? Option.some(new TextDecoder().decode(pipedBytes.value))
    : Option.none<string>();

  // Split the piped input into lines, dropping the trailing empty element left by a
  // final newline (production `Stream.splitLines` emits no line after the terminating
  // newline); interior blank lines are preserved.
  const lines = Option.isSome(pipedText) ? pipedText.value.split(/\r?\n/u) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let lineIndex = 0;

  return Layer.succeed(Stdin, {
    isTTY,
    readPipedBytes: Effect.succeed(pipedBytes),
    pipedBytesStream: Option.isSome(pipedBytes)
      ? Stream.fromIterable([pipedBytes.value])
      : Stream.empty,
    readPipedText: Effect.succeed(pipedText),
    // Dispenses the piped lines one per call (trimmed), then None once exhausted —
    // the timeout is irrelevant to a fixed mock. Mirrors the production persistent
    // reader so a command issuing several prompts reads successive lines.
    readLine: () =>
      Effect.sync(() => {
        if (lineIndex >= lines.length) {
          return Option.none<string>();
        }
        const line = (lines[lineIndex++] ?? "").trim();
        return line.length > 0 ? Option.some(line) : Option.none<string>();
      }),
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
    homeDir: opts.homeDir ?? defaultTestHomeDir,
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
  const exitDeferred = Deferred.makeUnsafe<number>();

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
      holdSignals: (_signals) => Effect.void,
      exit: (code: number) =>
        Effect.gen(function* () {
          exitCalls.push(code);
          yield* Deferred.succeed(exitDeferred, code);
          return yield* Effect.never;
        }),
      setExitCode: (code: number) =>
        Effect.sync(() => {
          exitCode = code;
        }),
      getExitCode: Effect.sync(() => exitCode),
    }),
    get exitCalls() {
      return exitCalls;
    },
    awaitExit: Deferred.await(exitDeferred),
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
    promptConfirmFail?: boolean;
    promptTextResponses?: ReadonlyArray<string>;
    promptSelectResponses?: ReadonlyArray<string>;
    promptPasswordResponses?: ReadonlyArray<string>;
    promptConfirmResponses?: ReadonlyArray<boolean>;
  } = {},
) {
  const messages: OutputMessage[] = [];
  const progressEvents: ProgressEvent[] = [];
  const events: OutputEvent[] = [];
  const rawChunks: Array<{ text: string; stream: "stdout" | "stderr" }> = [];
  const promptConfirmCalls: Array<{
    message: string;
    opts?: { defaultValue?: boolean };
  }> = [];
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
  const promptTextResponses = [...(opts.promptTextResponses ?? [])];
  const promptSelectResponses = [...(opts.promptSelectResponses ?? [])];
  const promptPasswordResponses = [...(opts.promptPasswordResponses ?? [])];
  const promptConfirmResponses = [...(opts.promptConfirmResponses ?? [])];
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
          return Effect.succeed(promptTextResponses.shift() ?? "123456");
        };
      })(),
      promptPassword: () => Effect.succeed(promptPasswordResponses.shift() ?? ""),
      promptConfirm: (message, promptOptions) =>
        Effect.sync(() => {
          promptConfirmCalls.push({ message, opts: promptOptions });
        }).pipe(
          Effect.flatMap(() =>
            opts.promptConfirmFail
              ? Effect.fail(
                  new NonInteractiveError({
                    detail: "Prompt cancelled",
                    suggestion: "Run in interactive mode",
                  }),
                )
              : Effect.succeed(
                  promptConfirmResponses.shift() ??
                    opts.confirmLogout ??
                    opts.confirmRelogin ??
                    true,
                ),
          ),
        ),
      promptSelect: (message, options, behavior) =>
        Effect.sync(() => {
          promptSelectCalls.push({ message, options, behavior });
          const response = promptSelectResponses.shift();
          return response ?? options[0]!.value;
        }),
      promptMultiSelect: (_message, options) =>
        Effect.succeed(options.map((option) => option.value)),
      raw: (text: string, stream: "stdout" | "stderr" = "stdout") =>
        Effect.sync(() => {
          rawChunks.push({ text, stream });
        }),
      rawBytes: (bytes: Uint8Array, stream: "stdout" | "stderr" = "stdout") =>
        Effect.sync(() => {
          rawChunks.push({ text: new TextDecoder().decode(bytes), stream });
        }),
    }),
    messages,
    progressEvents,
    events,
    promptConfirmCalls,
    promptSelectCalls,
    rawChunks,
    get stdoutText() {
      return rawChunks
        .filter((c) => c.stream === "stdout")
        .map((c) => c.text)
        .join("");
    },
    get stderrText() {
      return rawChunks
        .filter((c) => c.stream === "stderr")
        .map((c) => c.text)
        .join("");
    },
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

export function mockTelemetryRuntime(
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
      configDir: opts.configDir ?? join(defaultTestHomeDir, ".supabase"),
      tracesDir: opts.tracesDir ?? join(defaultTestHomeDir, ".supabase", "traces"),
      consent: opts.consent ?? "granted",
      showDebug: opts.showDebug ?? false,
      deviceId: opts.deviceId ?? "test-device-id",
      sessionId: opts.sessionId ?? "test-session-id",
      identity: makeTelemetryIdentity(opts.distinctId),
      isFirstRun: opts.isFirstRun ?? false,
      isTty: opts.isTty ?? false,
      isCi: opts.isCi ?? false,
      os: opts.os ?? "linux",
      arch: opts.arch ?? "x64",
      cliVersion: opts.cliVersion ?? "0.1.0",
    }),
  );
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

export function mockCliProjectContext(
  opts: {
    paths?: Option.Option<CliProjectPaths>;
    projectEnv?: Option.Option<CliProjectEnvironment>;
  } = {},
): Layer.Layer<CliProjectContext> {
  return Layer.succeed(
    CliProjectContext,
    CliProjectContext.of({
      paths: opts.paths ?? Option.none(),
      projectEnv: opts.projectEnv ?? Option.none(),
    }),
  );
}

export function mockCliProjectHome(
  opts: {
    projectRoot?: string;
    supabaseDir?: string;
    projectHomeDir?: string;
  } = {},
): Layer.Layer<CliProjectHome> {
  const projectRoot = opts.projectRoot ?? "/test/project";
  const supabaseDir = opts.supabaseDir ?? `${projectRoot}/supabase`;
  const projectHomeDir = opts.projectHomeDir ?? `${projectRoot}/.supabase`;

  return Layer.succeed(
    CliProjectHome,
    CliProjectHome.of({
      projectRoot,
      supabaseDir,
      projectHomeDir,
      projectLinkPath: `${projectHomeDir}/project.json`,
      projectLocalVersionsPath: `${projectHomeDir}/local-versions.json`,
      ensureCliProjectHomeDir: Effect.void,
    }),
  );
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

export function mockCliProjectLocalServiceVersions(
  initialState?: LocalServiceVersionsState,
): Layer.Layer<CliProjectLocalServiceVersions, never, never> {
  let state = initialState;
  return Layer.succeed(
    CliProjectLocalServiceVersions,
    CliProjectLocalServiceVersions.of({
      load: Effect.sync(() =>
        state === undefined ? Option.none<LocalServiceVersionsState>() : Option.some(state),
      ),
    }),
  );
}

export function emptyEnv() {
  const runtimeInfoLayer = mockRuntimeInfo();
  const cliProjectContextLayer = mockCliProjectContext();
  const envLayer = processEnvLayer();
  const cliProjectHomeLayer = mockCliProjectHome();
  const projectLinkStateLayer = mockProjectLinkState();
  const cliProjectLocalServiceVersionsLayer = mockCliProjectLocalServiceVersions();
  const analytics = mockAnalytics();
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    cliProjectContextLayer,
    cliProjectHomeLayer,
    projectLinkStateLayer,
    cliProjectLocalServiceVersionsLayer,
    analytics.layer,
    mockTelemetryRuntime(),
    envLayer,
    mockTty(),
    mockProcessControl().layer,
    cliSettingsLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(cliProjectContextLayer)),
  );
}

export function withEnv(env: Record<string, string>) {
  const runtimeInfoLayer = mockRuntimeInfo();
  const cliProjectContextLayer = mockCliProjectContext();
  const envLayer = processEnvLayer(env);
  const cliProjectHomeLayer = mockCliProjectHome();
  const analytics = mockAnalytics();
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    cliProjectContextLayer,
    cliProjectHomeLayer,
    analytics.layer,
    mockTelemetryRuntime(),
    envLayer,
    mockTty(),
    mockProcessControl().layer,
    cliSettingsLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(cliProjectContextLayer)),
  );
}
