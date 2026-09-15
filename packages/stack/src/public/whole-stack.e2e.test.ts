import { PgClient } from "@effect/sql-pg";
import {
  Clock,
  Config,
  Crypto,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  PlatformError,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Stream,
  type Duration,
} from "effect";
import { NodeServices } from "@effect/platform-node";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { Socket } from "node:net";
import { tmpdir } from "node:os";

import { WebSocket } from "ws";
import { afterAll, describe, expect, test } from "vitest";
import { createStack, listStacks, type PromiseStack } from "../index.ts";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { createTestStack, type TestStack } from "../testing.ts";
import { catalogEntryFor } from "../model/WorkloadCatalog.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import type { PromiseStackCredentials } from "./Credentials.ts";
import type { StackLogEntry } from "./Logs.ts";
import type { PromiseStackConfig } from "./PromiseStack.ts";
import type { StackEndpoint, StackStatus } from "./Status.ts";

const E2E_TIMEOUT_MS = 15 * 60_000;

const REQUEST_TIMEOUT_MS = 60_000;

const hostRuntime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer));
afterAll(() => hostRuntime.dispose());

const { join } = hostRuntime.runSync(Path.Path);

const runNode = <A, E>(
  program: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
  >,
) => hostRuntime.runPromise(program);

const execFileEffect = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((chunks) => chunks.join("")),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runCollect,
          Effect.map((chunks) => chunks.join("")),
        ),
        child.exitCode,
      ],
      { concurrency: 3 },
    );
    if (code !== 0)
      return yield* new E2ERequestError({ message: `${command} exited ${code}: ${stderr}` });
    return { stdout };
  }).pipe(Effect.scoped);

const withFs = <A, E>(operation: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  Effect.flatMap(FileSystem.FileSystem, operation);

const access = (path: string) => withFs((fs) => fs.access(path));

const mkdir = (path: string, options?: { recursive?: boolean }) =>
  withFs((fs) => fs.makeDirectory(path, options));

const readText = (path: string) => withFs((fs) => fs.readFileString(path));

const writeFile = (path: string, data: string) => withFs((fs) => fs.writeFileString(path, data));

const rm = (path: string, options: { recursive: boolean; force: boolean }) =>
  withFs((fs) => fs.remove(path, options));

const mkdtemp = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.makeTempDirectory({
      directory: path.dirname(prefix),
      prefix: path.basename(prefix),
    });
  });

const randomId = () =>
  hostRuntime.runSync(Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4));

const queryTimestamp = (offset: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(hostRuntime.runSync(Clock.currentTimeMillis) + offset));

const ANALYTICS_QUERY_RETRY_SCHEDULE = Schedule.spaced("1 second").pipe(
  Schedule.upTo({ duration: "3 minutes" }),
);

const MAILPIT_DELIVERY_RETRY_SCHEDULE = Schedule.spaced("250 millis").pipe(
  Schedule.upTo({ duration: "30 seconds" }),
);
// Studio's first lazy request can start four workloads sequentially (4 × 30s).
const LAZY_STUDIO_ACTIVATION_TIMEOUT_MS = 180_000;
// Pooler is activated by the first TCP connection and may take longer than the normal
// query deadline while its migration and tenant bootstrap processes run.
const LAZY_POOLER_ACTIVATION_TIMEOUT = "30 seconds";

const ALL_RUNTIME_CASES = [
  { name: "native", runtime: { kind: "native" as const } },
  { name: "Docker", runtime: { kind: "container" as const, engine: "docker" as const } },
] as const;

const SELECTED_RUNTIME = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);
if (
  SELECTED_RUNTIME !== undefined &&
  SELECTED_RUNTIME !== "native" &&
  SELECTED_RUNTIME !== "container"
)
  throw new Error(`Unsupported stack E2E runtime: ${SELECTED_RUNTIME}`);

const RUNTIME_CASES = ALL_RUNTIME_CASES.filter(
  ({ runtime }) => SELECTED_RUNTIME === undefined || runtime.kind === SELECTED_RUNTIME,
);

const databaseCatalog = catalogEntryFor("database:database");

const NON_DEFAULT_DATABASE_RELEASES = Object.keys(databaseCatalog.releases).filter(
  (version) => version !== databaseCatalog.defaultVersion,
);

const BASE_WORKLOAD_IDS = [
  "analytics:analytics",
  "analytics:vector",
  "auth:auth",
  "database:database",
  "functions:edge-runtime",
  "mail:mail",
  "pooler:pooler",
  "realtime:realtime",
  "rest:rest",
  "storage:imgproxy",
  "storage:storage",
  "studio:pgmeta",
  "studio:studio",
] as const;

const OPTIONAL_STORAGE_ANALYTICS_WORKLOAD_IDS = [
  "database:database",
  "analytics:vector",
  "analytics:analytics",
  "storage:imgproxy",
  "storage:storage",
] as const;

const ALL_EAGER_WORKLOAD_IDS = [
  "analytics:analytics",
  "analytics:vector",
  "auth:auth",
  "database:database",
  "functions:edge-runtime",
  "mail:mail",
  "pooler:pooler",
  "realtime:realtime",
  "rest:rest",
  "storage:imgproxy",
  "storage:storage",
  "studio:pgmeta",
  "studio:studio",
] as const;

const dockerOwnedResourceCount = (
  stackId: string,
  kind: "containers" | "networks" | "volumes",
): Effect.Effect<
  number,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const args =
      kind === "containers"
        ? ["ps", "-aq", "--filter", `label=com.supabase.stack.stackId=${stackId}`]
        : [
            kind === "networks" ? "network" : "volume",
            "ls",
            "-q",
            "--filter",
            `label=com.supabase.stack.stackId=${stackId}`,
          ];
    const result = yield* execFileEffect("docker", args);
    return result.stdout.trim().length === 0 ? 0 : result.stdout.trim().split("\n").length;
  });

const dockerOwnedWorkloadIds = (
  stackId: string,
): Effect.Effect<
  ReadonlyArray<string>,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const listed = yield* execFileEffect("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=com.supabase.stack.stackId=${stackId}`,
    ]);
    const ids = listed.stdout
      .trim()
      .split("\n")
      .filter((value) => value.length > 0);
    if (ids.length === 0) return [];
    const inspected = yield* execFileEffect("docker", [
      "inspect",
      "--format",
      '{{index .Config.Labels "com.supabase.stack.workloadId"}}',
      ...ids,
    ]);
    return [
      ...new Set(
        inspected.stdout
          .trim()
          .split("\n")
          .filter((value) => value.length > 0),
      ),
    ].sort();
  });
/** Native launchers carry the exact stack/workload marker in their command line. */
const nativeWorkloadIds = (
  stackId: string,
): Effect.Effect<
  ReadonlyArray<string>,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* execFileEffect("ps", ["-axo", "pid=,command="]);
    const marker = `supabase-stack-id=${stackId}`;
    return [
      ...new Set(
        result.stdout.split("\n").flatMap((line) => {
          if (!line.includes(marker)) return [];
          const match = /supabase-workload-id=([^\s]+)/u.exec(line);
          return match?.[1] === undefined ? [] : [match[1]];
        }),
      ),
    ].sort();
  });

const ownedWorkloadIds = (
  mode: (typeof RUNTIME_CASES)[number],
  stackId: string,
): Effect.Effect<
  ReadonlyArray<string>,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  mode.runtime.kind === "container" ? dockerOwnedWorkloadIds(stackId) : nativeWorkloadIds(stackId);

const expectOwnedWorkloads = (
  mode: (typeof RUNTIME_CASES)[number],
  stackId: string,
  expected: ReadonlyArray<string>,
): Effect.Effect<
  void,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  ownedWorkloadIds(mode, stackId).pipe(
    Effect.tap((actual) => Effect.sync(() => expect(actual).toEqual([...expected].sort()))),
    Effect.asVoid,
  );

const supervisorPids = (
  stackId: string,
): Effect.Effect<
  ReadonlyArray<number>,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* execFileEffect("ps", ["-axo", "pid=,command="]);
    return result.stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      if (match === null) return [];
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      return command.includes(stackId) &&
        (command.includes("supervisor-node.ts") ||
          command.includes("__supabase_stack_supervisor__"))
        ? [pid]
        : [];
    });
  });

const supervisorPid = (
  stackId: string,
): Effect.Effect<
  number,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const matches = yield* supervisorPids(stackId);
    if (matches.length !== 1)
      return yield* new E2ERequestError({
        message: `Expected one Supervisor process for ${stackId}, found ${matches.length}`,
      });
    const pid = matches[0];
    if (pid === undefined)
      return yield* new E2ERequestError({
        message: `Supervisor process for ${stackId} has no PID`,
      });
    return pid;
  });

const nativeDatabaseSharedMemoryId = (
  lockPath: string,
): Effect.Effect<number, E2ERequestError | PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const lines = (yield* readText(lockPath)).split("\n");
    const sharedMemoryId = Number(lines[6]?.trim().split(/\s+/u)[1]);
    if (!Number.isSafeInteger(sharedMemoryId) || sharedMemoryId < 0)
      return yield* new E2ERequestError({
        message: "Native database lock did not contain a valid shared-memory ID",
      });
    return sharedMemoryId;
  });

const nativeDatabaseSharedMemoryExists = (
  sharedMemoryId: number,
): Effect.Effect<
  boolean | undefined,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  if (process.platform !== "linux" && process.platform !== "darwin")
    return Effect.void.pipe(Effect.as(undefined));
  return execFileEffect("ipcs", ["-m"]).pipe(
    Effect.map((result) =>
      result.stdout
        .split("\n")
        .some((line) => line.trim().split(/\s+/u)[1] === String(sharedMemoryId)),
    ),
    Effect.catchIf(
      (cause) =>
        Predicate.isTagged(cause, "PlatformError") &&
        "reason" in cause &&
        Predicate.isTagged(cause.reason, "NotFound"),
      () => Effect.void.pipe(Effect.as(undefined)),
    ),
  );
};

const waitForProcessExit = (pid: number): Effect.Effect<void, E2ERequestError> => {
  const exited = Effect.try({
    try: () => {
      try {
        process.kill(pid, 0);
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ESRCH"
        )
          return;
        throw cause;
      }
      throw new Error(`Process ${pid} is still running`);
    },
    catch: (cause) =>
      new E2ERequestError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  return Effect.retry(exited, {
    schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "15 seconds" })),
  });
};
type JsonObject = Record<string, unknown>;
class E2ERequestError extends Data.TaggedError("E2ERequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const websocketDataText = (data: WebSocket.RawData): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
};

const endpoint = (status: StackStatus, name: keyof StackStatus["endpoints"]): StackEndpoint => {
  const value = status.endpoints[name];
  if (value === undefined) throw new Error(`Expected ${name} listener in stack status`);
  return value;
};

const capabilityState = (status: StackStatus, name: string): string | undefined =>
  status.capabilities.find((capability) => capability.name === name)?.state;

const expectDefaultLazyState = (status: StackStatus): void => {
  expect(status.lifecycle).toBe("running");
  expect(capabilityState(status, "database")).toBe("ready");
  expect(status.artifacts).toContainEqual(
    expect.objectContaining({
      workloadId: "database:database",
      capability: "database",
      state: "ready",
    }),
  );
  for (const name of CAPABILITY_NAMES) {
    if (name === "database") continue;
    expect(capabilityState(status, name), `${name} should remain dormant`).toBe("dormant");
  }
};
/** Wait for one capability transition while subscribing before sending traffic. */
// oxlint-disable-next-line effecttsgo/async-function -- TestStack status and action use the public Promise contract.
const activate = async <A>(
  stack: TestStack,
  name: string,
  action: () => Promise<A>,
): Promise<A> => {
  const before = await stack.status();
  expect(capabilityState(before, name), `${name} should be dormant before activation`).toBe(
    "dormant",
  );
  const waitUntilReady = Effect.tryPromise(() => stack.status()).pipe(
    Effect.flatMap((current) =>
      capabilityState(current, name) === "ready"
        ? Effect.succeed(current)
        : Effect.fail(new E2ERequestError({ message: `Capability ${name} is not ready yet` })),
    ),
    Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "3 minutes" }))),
  );
  const result = await action();
  await Effect.runPromise(waitUntilReady);
  return result;
};

const abortRequest = (
  signal: AbortSignal,
  requestDescription: string,
): Effect.Effect<never, E2ERequestError> =>
  Effect.callback<never, E2ERequestError>((resume) => {
    const onAbort = () => {
      const reason = signal.reason;
      resume(
        Effect.fail(
          new E2ERequestError({
            message: `${requestDescription} failed: ${reason instanceof Error ? reason.message : String(reason ?? "Request aborted")}`,
            cause: reason,
          }),
        ),
      );
    };
    if (signal.aborted) {
      onAbort();
      return Effect.void;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const request = (
  base: string,
  path: string,
  init: RequestInit = {},
  options: Readonly<{ expectedStatus?: number }> = {},
): Effect.Effect<Response, E2ERequestError, HttpClient.HttpClient> => {
  const url = new URL(path, `${base.replace(/\/$/u, "")}/`);
  const requestDescription = `${init.method ?? "GET"} ${url}`;
  const program = Effect.gen(function* () {
    const webRequest = new Request(url.href, init);
    let outgoing = HttpClientRequest.fromWeb(webRequest);
    if (webRequest.body !== null) {
      const bytes = yield* Effect.tryPromise({
        try: () => webRequest.arrayBuffer(),
        catch: (cause) => new E2ERequestError({ message: "Unable to read request body", cause }),
      });
      outgoing = HttpClientRequest.bodyUint8Array(
        outgoing,
        new Uint8Array(bytes),
        webRequest.headers.get("content-type") ?? undefined,
      );
    }
    const response = yield* HttpClient.execute(outgoing);
    const body = yield* response.arrayBuffer;
    const statusMatches =
      options.expectedStatus === undefined
        ? response.status >= 200 && response.status < 300
        : response.status === options.expectedStatus;
    if (!statusMatches)
      return yield* new E2ERequestError({
        message: `${init.method ?? "GET"} ${url} returned ${response.status}: ${new TextDecoder().decode(body)}`,
      });
    return new Response(response.status === 204 || response.status === 205 ? null : body, {
      status: response.status,
      headers: response.headers,
    });
  });
  const requestProgram =
    init.signal == null
      ? program.pipe(Effect.timeout(REQUEST_TIMEOUT_MS))
      : Effect.raceFirst(abortRequest(init.signal, requestDescription), program);
  return requestProgram.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof E2ERequestError) return cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      return new E2ERequestError({
        message: `${requestDescription} failed: ${reason}`,
        cause,
      });
    }),
  );
};

const connect = (endpoint: StackEndpoint): Effect.Effect<void, E2ERequestError> =>
  Effect.callback<void, E2ERequestError>((resume) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: Effect.Effect<void, E2ERequestError>) => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
      resume(result);
    };
    const onConnect = () => finish(Effect.void);
    const onError = (cause: Error) =>
      finish(Effect.fail(new E2ERequestError({ message: cause.message, cause })));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.connect(endpoint.port, endpoint.address);
    return Effect.sync(() => {
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.destroy();
    });
  }).pipe(
    Effect.timeout("2 seconds"),
    Effect.mapError(
      (cause) =>
        new E2ERequestError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

const expectEndpointsRefused = (endpoints: ReadonlyArray<StackEndpoint>): Effect.Effect<void> =>
  Effect.forEach(
    endpoints,
    (listener) =>
      connect(listener).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.void,
          onSuccess: () =>
            Effect.sync(() =>
              expect(false, `${listener.protocol} ${listener.url} should be closed`).toBe(true),
            ),
        }),
      ),
    { discard: true },
  );

const expectRuntimeInputsAbsent = (
  stack: Pick<TestStack, "stateRoot" | "id">,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathApi = yield* Path.Path;
    const stackRoot = pathApi.join(stack.stateRoot, stack.id);
    yield* fs.access(stackRoot);
    for (const relativePath of ["runtime/env", "runtime/inputs", "runtime/functions"]) {
      const path = pathApi.join(stackRoot, relativePath);
      yield* fs.readDirectory(path).pipe(
        Effect.tap((entries) =>
          Effect.sync(() =>
            expect(entries, `${path} should be empty after cleanup`).toHaveLength(0),
          ),
        ),
        Effect.catchIf(
          (cause) =>
            Predicate.isTagged(cause, "PlatformError") &&
            "reason" in cause &&
            Predicate.isTagged(cause.reason, "NotFound"),
          () => Effect.succeed([]),
        ),
      );
    }
  });

// oxlint-disable-next-line effecttsgo/async-function -- diagnostics consume the public TestStack Promise API.
const throwCapabilityDiagnostics = async (
  stack: TestStack,
  capabilityName: string,
  operation: string,
  cause: unknown,
): Promise<never> => {
  let status: StackStatus | undefined;
  try {
    status = await stack.status();
  } catch {
    // Preserve the original request failure when status is unavailable.
  }
  const capability = status?.capabilities.find(({ name }) => name === capabilityName);
  const recentLogs: StackLogEntry[] = [];
  try {
    for (const entry of (await stack.logs()).entries) {
      if (entry.source !== capabilityName && entry.source !== "gateway") continue;
      recentLogs.push(entry);
      if (recentLogs.length > 50) recentLogs.shift();
    }
  } catch {
    // Preserve the original request failure when logs are unavailable.
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  const state = capability === undefined ? "unavailable" : capability.state;
  const error = capability?.error === undefined ? "none" : capability.error;
  const logs =
    recentLogs.length === 0
      ? "none"
      : recentLogs.map((entry) => `${entry.source}/${entry.stream}: ${entry.message}`).join("\n");
  throw new Error(
    `${operation} failed: ${reason}; ${capabilityName} state=${state}; error=${error}; recent logs:\n${logs}`,
    { cause },
  );
};

const jsonValue = (response: Response): Effect.Effect<unknown, E2ERequestError> =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new E2ERequestError({ message: "Unable to decode JSON response", cause }),
  });

const jsonObject = (response: Response): Effect.Effect<JsonObject, E2ERequestError> =>
  Effect.gen(function* () {
    const value = yield* jsonValue(response);
    if (!isJsonObject(value))
      return yield* new E2ERequestError({ message: "Expected a JSON object response" });
    return Object.fromEntries(Object.entries(value));
  });

const databaseQuery = (
  url: string,
  statement: string,
  parameters: ReadonlyArray<unknown> = [],
  options: Readonly<{
    readonly connectTimeout?: Duration.Input;
  }> = {},
): Effect.Effect<ReadonlyArray<object>, E2ERequestError> => {
  let target = "<database>";
  try {
    const parsed = new URL(url);
    target = `${parsed.protocol}//${parsed.hostname}:${parsed.port || "default"}${parsed.pathname}`;
  } catch {
    // Keep diagnostics safe even when the connection URL is malformed.
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      return yield* client.unsafe(statement, parameters);
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          connectTimeout: options.connectTimeout ?? "10 seconds",
        }),
      ),
    ),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new E2ERequestError({
          message: `databaseQuery failed for ${target}: ${statement}`,
          cause,
        }),
    ),
  );
};

const apiCredentials = (credentials: PromiseStackCredentials) => {
  if (credentials.api === undefined) throw new Error("API credentials are required");
  return credentials.api;
};

const apiHeaders = (
  credentials: PromiseStackCredentials,
  token: string = apiCredentials(credentials).anonJwt,
): Record<string, string> => ({
  apikey: apiCredentials(credentials).publishableKey,
  Authorization: `Bearer ${token}`,
});

const serviceHeaders = (credentials: PromiseStackCredentials): Record<string, string> =>
  apiHeaders(credentials, apiCredentials(credentials).serviceRoleJwt);

const functionSource = (table: string, marker: string): string => `
Deno.serve(async (request) => {
  if (request.headers.get("x-reject-before-body") === "true") {
    return new Response("rejected", { status: 400 });
  }
  console.log("${marker}");
  let publishableKey: unknown;
  try {
    publishableKey = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
    ).default;
  } catch {
    publishableKey = undefined;
  }
  if (typeof publishableKey !== "string" || publishableKey.length === 0) {
    return new Response("Missing SUPABASE_PUBLISHABLE_KEYS.default", { status: 500 });
  }
  const response = await fetch(
    \`${'${Deno.env.get("SUPABASE_URL")}'}/rest/v1/${table}?select=id,payload\`,
    {
      headers: {
        apikey: publishableKey,
        Authorization: \`Bearer \${publishableKey}\`,
      },
    },
  );
  const body = await response.text();
  return new Response(JSON.stringify({
    marker: "${marker}",
    functionSlug: Deno.env.get("SUPABASE_FUNCTION_SLUG"),
    rows: JSON.parse(body),
  }), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
});
`;

const waitForSocket = (
  socket: WebSocket,
  predicate: (value: JsonObject) => boolean,
): Effect.Effect<JsonObject, E2ERequestError> =>
  Effect.callback<JsonObject, E2ERequestError>((resume) => {
    let settled = false;
    const finish = (result: Effect.Effect<JsonObject, E2ERequestError>) => {
      if (settled) return;
      settled = true;
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      resume(result);
    };
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const value: unknown = JSON.parse(websocketDataText(data));
        if (isJsonObject(value) && predicate(value))
          finish(Effect.succeed(Object.fromEntries(Object.entries(value))));
      } catch {
        // Realtime can send non-JSON protocol frames.
      }
    };
    const onError = () =>
      finish(
        Effect.fail(new E2ERequestError({ message: "Realtime WebSocket failed while waiting" })),
      );
    const onClose = () =>
      finish(
        Effect.fail(new E2ERequestError({ message: "Realtime WebSocket closed while waiting" })),
      );
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
    return Effect.sync(() => {
      settled = true;
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    });
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT_MS),
    Effect.mapError(
      (cause) =>
        new E2ERequestError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

const openSocket = (url: string): Effect.Effect<WebSocket, E2ERequestError> =>
  Effect.callback<WebSocket, E2ERequestError>((resume) => {
    const socket = new WebSocket(url, {
      handshakeTimeout: REQUEST_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    let settled = false;
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", cleanup);
    };
    const terminate = () => {
      socket.off("open", onOpen);
      // Terminating an unfinished handshake emits an error before close.
      socket.once("close", cleanup);
      socket.terminate();
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.succeed(socket));
    };
    const onError = (cause: Error) => {
      if (settled) return;
      settled = true;
      terminate();
      resume(Effect.fail(new E2ERequestError({ message: cause.message, cause })));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      terminate();
    });
  });

const makeRealtimeUrl = (api: StackEndpoint, apikey: string): string => {
  const url = new URL(api.url);
  url.protocol = api.protocol === "http" ? "ws:" : "wss:";
  url.pathname = "/realtime/v1/websocket";
  url.search = new URLSearchParams({ apikey, vsn: "1.0.0" }).toString();
  return url.toString();
};

const onePixelPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

const optionalWorkloadConfig = (
  functionSlug: string,
  analyticsApiKey: string,
): PromiseStackConfig => ({
  capabilities: {
    storage: { settings: { image_transformation: { enabled: true } } },
    functions: { settings: { functions: { [functionSlug]: { verify_jwt: false } } } },
    analytics: { settings: { api_key: analyticsApiKey } },
  },
  listeners: { smtp: { enabled: true } },
});

const allEagerConfig = (analyticsApiKey: string): PromiseStackConfig => ({
  capabilities: {
    rest: { activation: "eager" },
    auth: { activation: "eager" },
    realtime: { activation: "eager" },
    storage: {
      activation: "eager",
      settings: { image_transformation: { enabled: true } },
    },
    functions: { activation: "eager" },
    studio: { activation: "eager" },
    mail: { activation: "eager" },
    analytics: {
      activation: "eager",
      settings: { api_key: analyticsApiKey },
    },
    pooler: { activation: "eager" },
  },
  listeners: { smtp: { enabled: true } },
});

const queryAnalyticsMarker = (
  api: StackEndpoint,
  analyticsApiKey: string,
  marker: string,
): Effect.Effect<number, E2ERequestError, HttpClient.HttpClient> => {
  const query = new URLSearchParams({
    project: "default",
    iso_timestamp_start: queryTimestamp(-3_600_000),
    iso_timestamp_end: queryTimestamp(3_600_000),
    sql:
      "select count(*) as c from postgres_logs where regexp_contains(event_message, '" +
      marker +
      "')",
  });
  const attempt = Effect.gen(function* () {
    const response = yield* request(
      api.url,
      "/analytics/v1/api/endpoints/query/logs.all?" + query,
      { headers: { "x-api-key": analyticsApiKey } },
    );
    const value = yield* jsonValue(response);
    if (!isJsonObject(value))
      return yield* new E2ERequestError({ message: "Expected a JSON object response" });
    const responseObject = value;
    const rows = responseObject.result;
    const count = Array.isArray(rows) && isJsonObject(rows[0]) ? Number(rows[0].c) : 0;
    if (count <= 0)
      return yield* new E2ERequestError({ message: `Analytics query pending (count=${count})` });
    return count;
  });
  return Effect.retry(attempt, { schedule: ANALYTICS_QUERY_RETRY_SCHEDULE });
};
type RuntimeCase = (typeof RUNTIME_CASES)[number];
type WholeStackMarkers = Readonly<{
  first: string;
  second: string;
  live: string;
}>;
type WholeStackScenario = Readonly<{
  mode: RuntimeCase;
  stack: TestStack;
  identity: string;
  projectRoot: string;
  table: string;
  bucket: string;
  functionSlug: string;
  email: string;
  password: string;
  markers: WholeStackMarkers;
  credentials: PromiseStackCredentials;
  api: StackEndpoint;
  pooler: StackEndpoint;
  studio: StackEndpoint;
  mailUi: StackEndpoint;
}>;

const arrangeWholeStackDatabase = (
  scenario: WholeStackScenario,
): Effect.Effect<void, E2ERequestError> => {
  const { credentials, markers, table } = scenario;
  return Effect.gen(function* () {
    yield* databaseQuery(
      credentials.database.url,
      `CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`,
    );
    yield* databaseQuery(
      credentials.database.url,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${table}" TO anon, authenticated, service_role`,
    );
    yield* databaseQuery(
      credentials.database.url,
      `ALTER PUBLICATION supabase_realtime ADD TABLE public."${table}"`,
    );
    const directRows = yield* databaseQuery(
      credentials.database.url,
      `INSERT INTO public."${table}" (id, payload) VALUES (1, $1) RETURNING id, payload`,
      [markers.first],
    );
    yield* Effect.sync(() => expect(directRows).toEqual([{ id: 1, payload: markers.first }]));
  });
};

// oxlint-disable-next-line effecttsgo/async-function -- this verifies the public async log iterator contract.
const verifyWholeStackDatabaseLogs = async (stack: TestStack): Promise<void> => {
  expect((await stack.logs({ capabilities: ["database"], tail: 1 })).entries).not.toHaveLength(0);
  const logIterator = stack
    .followLogs({ capabilities: ["database"], tail: 1 })
    [Symbol.asyncIterator]();
  try {
    const logEntry = await logIterator.next();
    expect(logEntry.done).toBe(false);
    if (!logEntry.done) expect(logEntry.value.source).toBe("database");
  } finally {
    await logIterator.return?.();
  }
};

// oxlint-disable-next-line effecttsgo/async-function -- this scenario consumes the public TestStack Promise contract.
const exerciseWholeStackRestAndAuth = async (
  scenario: WholeStackScenario,
): Promise<{
  readonly restPath: string;
  readonly accessToken: string;
}> => {
  const { api, credentials, email, identity, password, markers, stack, table } = scenario;
  const restPath = `/rest/v1/${table}?select=id,payload&order=id`;
  const restRows = await activate(stack, "rest", () =>
    runNode(
      request(api.url, restPath, {
        headers: { ...apiHeaders(credentials), Accept: "application/json" },
      }).pipe(Effect.flatMap(jsonValue)),
    ),
  );
  expect(restRows).toEqual(expect.arrayContaining([{ id: 1, payload: markers.first }]));
  const signup = await activate(stack, "auth", () =>
    runNode(
      request(api.url, "/auth/v1/signup", {
        method: "POST",
        headers: { ...apiHeaders(credentials), "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }).pipe(Effect.flatMap(jsonObject)),
    ),
  );
  const accessToken = signup.access_token;
  if (typeof accessToken !== "string")
    throw new Error("Auth signup did not return an access token");
  const authenticatedInsert = await runNode(
    request(api.url, `/rest/v1/${table}`, {
      method: "POST",
      headers: {
        ...apiHeaders(credentials, accessToken),
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ id: 2, payload: `auth-${identity}` }),
    }).pipe(Effect.flatMap(jsonValue)),
  );
  expect(authenticatedInsert).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 2, payload: `auth-${identity}` })]),
  );
  return { restPath, accessToken };
};

// oxlint-disable-next-line effecttsgo/async-function -- this scenario consumes the public TestStack Promise contract.
const exerciseWholeStackRealtime = async (
  scenario: WholeStackScenario,
  accessToken: string,
): Promise<void> => {
  const { api, credentials, identity, stack, table } = scenario;
  let openedSocket: WebSocket | undefined;
  let socket: WebSocket;
  try {
    socket = await activate(stack, "realtime", () =>
      runNode(
        openSocket(makeRealtimeUrl(api, apiCredentials(credentials).publishableKey)).pipe(
          Effect.tap((candidate) => Effect.sync(() => void (openedSocket = candidate))),
        ),
      ),
    );
  } catch (cause) {
    openedSocket?.close();
    throw cause;
  }
  const socketWaiters: Array<Promise<JsonObject>> = [];
  try {
    const joined = runNode(
      waitForSocket(socket, (value) => {
        const payload = value.payload;
        return value.event === "phx_reply" && typeof payload === "object" && payload !== null;
      }),
    );
    socketWaiters.push(joined);
    const subscribed = runNode(
      waitForSocket(socket, (value) => {
        const payload = value.payload;
        return (
          value.event === "system" &&
          isJsonObject(payload) &&
          payload.status === "ok" &&
          payload.extension === "postgres_changes"
        );
      }),
    );
    socketWaiters.push(subscribed);
    const change = runNode(waitForSocket(socket, (value) => value.event === "postgres_changes"));
    socketWaiters.push(change);
    socket.send(
      JSON.stringify({
        topic: `realtime:public:${table}`,
        event: "phx_join",
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "" },
            postgres_changes: [{ event: "INSERT", schema: "public", table }],
          },
          access_token: accessToken,
        },
        ref: "1",
      }),
    );
    await joined;
    await subscribed;
    await runNode(
      request(api.url, `/rest/v1/${table}`, {
        method: "POST",
        headers: {
          ...apiHeaders(credentials, accessToken),
          "content-type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ id: 3, payload: `realtime-${identity}` }),
      }),
    );
    const realtimeChange = await change;
    expect(JSON.stringify(realtimeChange)).toContain(`realtime-${identity}`);
  } finally {
    socket.close();
    await Promise.allSettled(socketWaiters);
  }
};

// oxlint-disable-next-line effecttsgo/async-function -- this scenario consumes the public TestStack Promise contract.
const exerciseWholeStackStorage = async (scenario: WholeStackScenario): Promise<void> => {
  const { api, bucket, credentials, stack } = scenario;
  await activate(stack, "storage", () =>
    runNode(
      Effect.gen(function* () {
        yield* request(api.url, "/storage/v1/bucket", {
          method: "POST",
          headers: { ...serviceHeaders(credentials), "content-type": "application/json" },
          body: encodeJson({ id: bucket, name: bucket, public: true }),
        });
        yield* request(api.url, `/storage/v1/object/${bucket}/pixel.png`, {
          method: "POST",
          headers: { ...serviceHeaders(credentials), "content-type": "image/png" },
          body: new Blob([onePixelPng], { type: "image/png" }),
        });
        const downloaded = yield* request(
          api.url,
          `/storage/v1/object/public/${bucket}/pixel.png`,
          { headers: serviceHeaders(credentials) },
        );
        const bytes = yield* Effect.tryPromise(() => downloaded.arrayBuffer());
        yield* Effect.sync(() => expect(bytes.byteLength).toBeGreaterThan(0));
      }),
    ),
  );
};

// oxlint-disable-next-line effecttsgo/async-function -- this scenario consumes public TestStack Promise and async log iterator contracts.
const exerciseWholeStackFunctions = async (scenario: WholeStackScenario): Promise<void> => {
  const { api, credentials, functionSlug, markers, projectRoot, stack, table } = scenario;
  const functionPath = `/functions/v1/${functionSlug}`;
  try {
    let firstFunction: JsonObject = {};
    await activate(stack, "functions", () =>
      runNode(
        request(api.url, functionPath, { headers: apiHeaders(credentials) }).pipe(
          Effect.flatMap(jsonObject),
          Effect.tap((value) => Effect.sync(() => void (firstFunction = value))),
        ),
      ),
    );
    expect(firstFunction).toEqual(
      expect.objectContaining({
        marker: markers.first,
        functionSlug,
        rows: expect.arrayContaining([{ id: 1, payload: markers.first }]),
      }),
    );
    const earlyResponse = await runNode(
      request(
        api.url,
        functionPath,
        {
          method: "POST",
          headers: { ...apiHeaders(credentials), "x-reject-before-body": "true" },
          body: new Uint8Array(128 * 1024),
          signal: AbortSignal.timeout(5_000),
        },
        { expectedStatus: 400 },
      ),
    );
    expect(earlyResponse.status).toBe(400);
    expect(await earlyResponse.text()).toBe("rejected");

    await runNode(
      writeFile(
        join(projectRoot, "supabase", "functions", functionSlug, "index.ts"),
        functionSource(table, markers.second),
      ),
    );
    const secondFunction = await runNode(
      request(api.url, functionPath, { headers: apiHeaders(credentials) }).pipe(
        Effect.flatMap(jsonObject),
      ),
    );
    expect(secondFunction).toEqual(
      expect.objectContaining({
        marker: markers.second,
        functionSlug,
        rows: expect.arrayContaining([{ id: 1, payload: markers.first }]),
      }),
    );
    const beforeLiveLogs = await stack.logs({ capabilities: ["functions"] });
    const liveIterator = stack
      .followLogs({ capabilities: ["functions"], cursor: beforeLiveLogs.cursor })
      [Symbol.asyncIterator]();
    try {
      const liveNext = liveIterator.next();
      await runNode(
        writeFile(
          join(projectRoot, "supabase", "functions", functionSlug, "index.ts"),
          functionSource(table, markers.live),
        ),
      );
      await runNode(
        request(api.url, functionPath, { headers: apiHeaders(credentials) }).pipe(
          Effect.flatMap(jsonObject),
        ),
      );
      let liveEntry = await liveNext;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (liveEntry.done) break;
        if (
          liveEntry.value.source === "functions" &&
          liveEntry.value.message.includes(markers.live)
        )
          break;
        liveEntry = await liveIterator.next();
      }
      expect(liveEntry.done).toBe(false);
      if (!liveEntry.done) {
        expect(liveEntry.value.source).toBe("functions");
        expect(liveEntry.value.message).toContain(markers.live);
      }
    } finally {
      await liveIterator.return?.();
    }
    expect((await liveIterator.next()).done).toBe(true);
  } catch (cause) {
    await throwCapabilityDiagnostics(stack, "functions", "Functions flow", cause);
  }
};

// oxlint-disable-next-line effecttsgo/async-function -- this scenario consumes the public TestStack Promise contract.
const exerciseWholeStackAuxiliary = async (scenario: WholeStackScenario): Promise<URL> => {
  const { api, credentials, mailUi, pooler, stack, studio } = scenario;
  await activate(stack, "mail", () => runNode(request(mailUi.url, "/api/v1/messages?limit=100")));
  await activate(stack, "analytics", () => runNode(request(api.url, "/analytics/v1/health")));
  try {
    await activate(stack, "studio", () =>
      runNode(
        request(studio.url, "/api/platform/profile", {
          headers: serviceHeaders(credentials),
          signal: AbortSignal.timeout(LAZY_STUDIO_ACTIVATION_TIMEOUT_MS),
        }),
      ),
    );
  } catch (cause) {
    await throwCapabilityDiagnostics(stack, "studio", "Studio profile request", cause);
  }
  const poolerUrl = new URL(credentials.database.url);
  poolerUrl.port = String(pooler.port);
  poolerUrl.username = "postgres.pooler-dev";
  const poolerRows = await activate(stack, "pooler", () =>
    runNode(
      databaseQuery(poolerUrl.toString(), "SELECT 42 AS answer", [], {
        connectTimeout: LAZY_POOLER_ACTIVATION_TIMEOUT,
      }),
    ),
  );
  expect(poolerRows).toEqual([{ answer: 42 }]);
  return poolerUrl;
};

const assertWholeStackReady = (
  scenario: WholeStackScenario,
  status: StackStatus,
): Effect.Effect<
  void,
  E2ERequestError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      expect(status.capabilities.map(({ name, state }) => ({ name, state }))).toEqual(
        CAPABILITY_NAMES.map((name) => ({ name, state: "ready" })),
      );
      for (const workloadId of ["studio:pgmeta", "studio:studio"] as const) {
        expect(status.artifacts).toContainEqual(
          expect.objectContaining({ workloadId, capability: "studio", state: "ready" }),
        );
      }
    });
    yield* expectOwnedWorkloads(scenario.mode, scenario.stack.id, BASE_WORKLOAD_IDS);
  });

// oxlint-disable-next-line effecttsgo/async-function -- this helper consumes the public TestStack Promise contract.
const reactivateWholeStackCapabilities = async (
  scenario: WholeStackScenario,
  restPath: string,
  functionPath: string,
  poolerUrl: URL,
): Promise<void> => {
  const { api, credentials, mailUi, stack, studio } = scenario;
  await activate(stack, "rest", () =>
    runNode(request(api.url, restPath, { headers: apiHeaders(credentials) })),
  );
  await activate(stack, "auth", () =>
    runNode(request(api.url, "/auth/v1/settings", { headers: apiHeaders(credentials) })),
  );
  await activate(stack, "realtime", () =>
    runNode(
      openSocket(makeRealtimeUrl(api, apiCredentials(credentials).publishableKey)).pipe(
        Effect.tap((probe) => Effect.sync(() => probe.close())),
        Effect.asVoid,
      ),
    ),
  );
  await activate(stack, "storage", () =>
    runNode(request(api.url, "/storage/v1/bucket", { headers: serviceHeaders(credentials) })),
  );
  await activate(stack, "functions", () =>
    runNode(request(api.url, functionPath, { headers: apiHeaders(credentials) })),
  );
  await activate(stack, "mail", () => runNode(request(mailUi.url, "/api/v1/messages?limit=1")));
  await activate(stack, "analytics", () => runNode(request(api.url, "/analytics/v1/health")));
  await activate(stack, "studio", () =>
    runNode(
      request(studio.url, "/api/platform/profile", {
        headers: serviceHeaders(credentials),
        signal: AbortSignal.timeout(LAZY_STUDIO_ACTIVATION_TIMEOUT_MS),
      }),
    ),
  );
  await activate(stack, "pooler", () =>
    runNode(
      databaseQuery(poolerUrl.toString(), "SELECT 42 AS answer", [], {
        connectTimeout: LAZY_POOLER_ACTIVATION_TIMEOUT,
      }),
    ),
  );
};

// oxlint-disable-next-line effecttsgo/async-function -- restart flow consumes the public TestStack Promise API.
const restartWholeStackFromPersistedData = async (
  scenario: WholeStackScenario,
  endpointSnapshot: Readonly<Record<string, number | undefined>>,
  restPath: string,
  functionPath: string,
  poolerUrl: URL,
): Promise<void> => {
  const { credentials, markers, mode, stack, table } = scenario;
  const restarted = await stack.start();
  expectDefaultLazyState(restarted);
  await runNode(expectOwnedWorkloads(mode, stack.id, ["database:database"]));
  expect(
    Object.fromEntries(
      Object.entries(restarted.endpoints).map(([name, value]) => [name, value?.port]),
    ),
  ).toEqual(endpointSnapshot);
  expect(
    await runNode(
      databaseQuery(credentials.database.url, `SELECT payload FROM public."${table}" WHERE id = 1`),
    ),
  ).toEqual([{ payload: markers.first }]);
  await reactivateWholeStackCapabilities(scenario, restPath, functionPath, poolerUrl);
};

// oxlint-disable-next-line effecttsgo/async-function -- whole-stack flow consumes PromiseStack and AsyncDisposable contracts.
const runWholeStackScenario = async (mode: (typeof RUNTIME_CASES)[number]): Promise<void> => {
  const identity = randomId().replaceAll("-", "").slice(0, 20).toLowerCase();
  const table = `stack_e2e_${identity}`;
  const bucket = `stack-e2e-${identity}`;
  const functionSlug = `cross_service_${identity}`;
  const email = `${identity}@example.test`;
  const password = "SupabaseStackE2e!123";
  const markers = {
    first: `first-${identity}`,
    second: `second-${identity}`,
    live: `live-${identity}`,
  };
  let projectRoot = "";
  await using stack: TestStack = await createTestStack({
    name: `stack-e2e-${identity}`,
    runtime: mode.runtime,
    setupProject: (root) => {
      projectRoot = root;
      const directory = join(root, "supabase", "functions", functionSlug);
      return runNode(
        Effect.gen(function* () {
          yield* mkdir(directory, { recursive: true });
          yield* writeFile(join(directory, "index.ts"), functionSource(table, markers.first));
        }),
      );
    },
  });
  const initialRunning = await stack.status();
  expect(initialRunning.runtime).toEqual(mode.runtime);
  expect(projectRoot.length).toBeGreaterThan(0);
  expectDefaultLazyState(initialRunning);
  await runNode(expectOwnedWorkloads(mode, stack.id, ["database:database"]));
  // Preparation is an explicit cache-only operation. It runs after the helper's
  // initial session is stopped, so the test proves it creates no owner, listener,
  // or workload.
  const initialSupervisorPid = await runNode(supervisorPid(stack.id));
  await stack.stop();
  const warmed = await stack.prepare({ capabilities: ["rest"] });
  expect(warmed.capabilities).toEqual(
    expect.arrayContaining([expect.objectContaining({ capability: "rest" })]),
  );
  expect((await stack.status()).lifecycle).toBe("stopped");
  await runNode(
    expectEndpointsRefused(
      Object.values(initialRunning.endpoints).filter(
        (value): value is StackEndpoint => value !== undefined,
      ),
    ),
  );
  // Process exit follows lease finalization for a detached supervisor. Observe the exact
  // owner PID before scanning for leftovers, without masking a genuine process leak.
  await runNode(waitForProcessExit(initialSupervisorPid));
  expect(await runNode(supervisorPids(stack.id))).toHaveLength(0);
  const initial = await stack.start();
  expectDefaultLazyState(initial);
  await runNode(expectOwnedWorkloads(mode, stack.id, ["database:database"]));
  const credentials = await stack.credentials();
  const api = endpoint(initial, "api");
  const pooler = endpoint(initial, "pooler");
  const studio = endpoint(initial, "studio");
  const mailUi = endpoint(initial, "mailUi");
  const initialEndpoints = Object.values(initial.endpoints).filter(
    (value): value is StackEndpoint => value !== undefined,
  );
  // The warmed capability remains lazy: only its artifact is cached, not its
  // workload. The first request below still performs the normal activation.
  const scenario: WholeStackScenario = {
    mode,
    stack,
    identity,
    projectRoot,
    table,
    bucket,
    functionSlug,
    email,
    password,
    markers,
    credentials,
    api,
    pooler,
    studio,
    mailUi,
  };
  await runNode(arrangeWholeStackDatabase(scenario));
  await verifyWholeStackDatabaseLogs(stack);
  const { restPath, accessToken } = await exerciseWholeStackRestAndAuth(scenario);
  await exerciseWholeStackRealtime(scenario, accessToken);
  await exerciseWholeStackStorage(scenario);
  // Functions are request-time discovered and call REST through SUPABASE_URL.
  const functionPath = `/functions/v1/${functionSlug}`;
  await exerciseWholeStackFunctions(scenario);
  const poolerUrl = await exerciseWholeStackAuxiliary(scenario);
  const ready = await stack.status();
  await runNode(assertWholeStackReady(scenario, ready));
  const idempotentStart = await stack.start();
  await runNode(assertWholeStackReady(scenario, idempotentStart));
  const endpointSnapshot = Object.fromEntries(
    Object.entries(ready.endpoints).map(([name, value]) => [name, value?.port]),
  );
  const persistedMarker = await runNode(
    databaseQuery(credentials.database.url, `SELECT payload FROM public."${table}" WHERE id = 1`),
  );
  expect(persistedMarker).toEqual([{ payload: markers.first }]);
  const volumesBeforeStop =
    mode.runtime.kind === "container"
      ? await runNode(dockerOwnedResourceCount(initial.id, "volumes"))
      : undefined;
  try {
    await stack.stop();
  } catch (cause) {
    let diagnostic: StackStatus | undefined;
    try {
      diagnostic = await stack.status();
    } catch {
      // Preserve the original stop failure if the owner is already gone.
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    const states =
      diagnostic === undefined
        ? "unavailable"
        : diagnostic.capabilities
            .map(
              ({ name, state, error }) =>
                `${name}=${state}${error === undefined ? "" : ` (${error})`}`,
            )
            .join(", ");
    throw new Error(
      `Stack stop failed: ${reason}; lifecycle=${diagnostic?.lifecycle ?? "unknown"}; ${states}`,
      {
        cause,
      },
    );
  }
  const stopped = await stack.status();
  expect(stopped.lifecycle).toBe("stopped");
  expect(stopped.capabilities.every(({ state }) => state === "stopped")).toBe(true);
  expect(stopped.artifacts).toEqual([]);
  await runNode(expectOwnedWorkloads(mode, stack.id, []));
  const retainedLogs: StackLogEntry[] = (await stack.logs()).entries.slice();
  expect(retainedLogs.length).toBeGreaterThan(0);
  await runNode(expectRuntimeInputsAbsent(stack));
  await runNode(expectEndpointsRefused(initialEndpoints));
  if (mode.runtime.kind === "container") {
    expect(await runNode(dockerOwnedResourceCount(initial.id, "containers"))).toBe(0);
    expect(await runNode(dockerOwnedResourceCount(initial.id, "networks"))).toBe(0);
    expect(await runNode(dockerOwnedResourceCount(initial.id, "volumes"))).toBe(volumesBeforeStop);
  }
  await restartWholeStackFromPersistedData(
    scenario,
    endpointSnapshot,
    restPath,
    functionPath,
    poolerUrl,
  );
  await stack.stop();
  await restartWholeStackFromPersistedData(
    scenario,
    endpointSnapshot,
    restPath,
    functionPath,
    poolerUrl,
  );
  const final = await stack.status();
  await runNode(assertWholeStackReady(scenario, final));
  await stack.stop();
  await runNode(expectOwnedWorkloads(mode, stack.id, []));
  const reconfigured = await stack.start({
    config: {
      capabilities: { studio: { enabled: false } },
      listeners: {
        api: { port: studio.port },
        studio: { enabled: false },
      },
    },
  });
  expect(capabilityState(reconfigured, "database")).toBe("ready");
  expect(capabilityState(reconfigured, "studio")).toBe("disabled");
  expect(endpoint(reconfigured, "api").port).toBe(studio.port);
  expect(endpoint(reconfigured, "api").port).not.toBe(api.port);
  expect(reconfigured.endpoints.studio).toBeUndefined();
};
describe("managed Supabase stack whole-stack E2E", () => {
  test.skipIf(SELECTED_RUNTIME === "container")(
    "recovers the native database after abrupt Supervisor termination",
    { timeout: E2E_TIMEOUT_MS },
    // oxlint-disable-next-line effecttsgo/async-function -- Vitest callback consumes the public TestStack Promise contract.
    async () => {
      await using stack: TestStack = await createTestStack({
        name: `stack-crash-recovery-${randomId().replaceAll("-", "").slice(0, 16)}`,
        runtime: { kind: "native" },
      });
      const before = await stack.status();
      const database = endpoint(before, "database");
      const lockPath = join(stack.stateRoot, stack.id, "data", "database", "postmaster.pid");
      const databasePid = Number((await runNode(readText(lockPath))).split("\n", 1)[0]);
      if (!Number.isSafeInteger(databasePid) || databasePid <= 0)
        throw new Error("Native database lock did not contain a valid PID");
      const sharedMemoryId = await runNode(nativeDatabaseSharedMemoryId(lockPath));
      const sharedMemoryAvailable = await runNode(nativeDatabaseSharedMemoryExists(sharedMemoryId));
      if (sharedMemoryAvailable !== undefined) expect(sharedMemoryAvailable).toBe(true);
      process.kill(await runNode(supervisorPid(stack.id)), "SIGKILL");
      await runNode(waitForProcessExit(databasePid));
      if (sharedMemoryAvailable !== undefined)
        expect(await runNode(nativeDatabaseSharedMemoryExists(sharedMemoryId))).toBe(false);
      await expect(runNode(connect(database))).rejects.toThrow();
      await expect(runNode(access(lockPath))).rejects.toThrow();
      const recovered = await stack.start();
      expectDefaultLazyState(recovered);
      expect(
        await runNode(databaseQuery((await stack.credentials()).database.url, "SELECT 1 AS value")),
      ).toEqual([{ value: 1 }]);
    },
  );
  for (const mode of RUNTIME_CASES) {
    for (const databaseVersion of NON_DEFAULT_DATABASE_RELEASES) {
      const major = databaseVersion.split(".")[0];
      test(
        `starts PostgreSQL ${major} in ${mode.name} mode`,
        { timeout: E2E_TIMEOUT_MS },
        // oxlint-disable-next-line effecttsgo/async-function -- Vitest callback consumes the public TestStack Promise and AsyncDisposable contracts.
        async () => {
          await using stack: TestStack = await createTestStack({
            name: `stack-postgres-${major}-${randomId().replaceAll("-", "").slice(0, 16)}`,
            runtime: mode.runtime,
            config: { capabilities: { database: { version: major } } },
          });
          const rows = await runNode(
            databaseQuery(
              (await stack.credentials()).database.url,
              "SELECT current_setting('server_version') AS version",
            ),
          );
          expect(rows).toEqual([{ version: expect.stringMatching(new RegExp(`^${major}\\.`)) }]);
        },
      );
    }
    test(
      `coordinates concurrent isolated stacks in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      // oxlint-disable-next-line effecttsgo/async-function -- concurrent test consumes PromiseStack and AsyncDisposable contracts.
      async () => {
        const identity = randomId().replaceAll("-", "").slice(0, 16);
        const creations = await Promise.allSettled([
          createTestStack({
            name: `stack-concurrent-a-${identity}`,
            runtime: mode.runtime,
          }),
          createTestStack({
            name: `stack-concurrent-b-${identity}`,
            runtime: mode.runtime,
          }),
        ]);
        const firstResult = creations[0];
        const secondResult = creations[1];
        if (firstResult?.status !== "fulfilled" || secondResult?.status !== "fulfilled") {
          await Promise.allSettled(
            creations.flatMap((result) =>
              result.status === "fulfilled" ? [result.value[Symbol.asyncDispose]()] : [],
            ),
          );
          const firstRejection = creations.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (firstRejection !== undefined) throw firstRejection.reason;
          throw new Error("Concurrent test stack creation returned an incomplete result");
        }
        const firstStack = firstResult.value;
        const secondStack = secondResult.value;
        await using first: TestStack = firstStack;
        await using second: TestStack = secondStack;
        const [firstStatus, secondStatus] = await Promise.all([first.status(), second.status()]);
        expect(firstStatus.lifecycle).toBe("running");
        expect(secondStatus.lifecycle).toBe("running");
        const firstApi = endpoint(firstStatus, "api");
        const secondApi = endpoint(secondStatus, "api");
        expect(firstApi.port).not.toBe(secondApi.port);
        const [firstCredentials, secondCredentials] = await Promise.all([
          first.credentials(),
          second.credentials(),
        ]);
        const firstTable = `concurrent_${identity}_a`;
        const secondTable = `concurrent_${identity}_b`;
        const firstMarker = `marker-a-${identity}`;
        const secondMarker = `marker-b-${identity}`;
        await Promise.all([
          runNode(
            databaseQuery(
              firstCredentials.database.url,
              `CREATE TABLE public."${firstTable}" (payload text NOT NULL)`,
            ),
          ),
          runNode(
            databaseQuery(
              secondCredentials.database.url,
              `CREATE TABLE public."${secondTable}" (payload text NOT NULL)`,
            ),
          ),
        ]);
        await Promise.all([
          runNode(
            databaseQuery(
              firstCredentials.database.url,
              `INSERT INTO public."${firstTable}" (payload) VALUES ($1)`,
              [firstMarker],
            ),
          ),
          runNode(
            databaseQuery(
              secondCredentials.database.url,
              `INSERT INTO public."${secondTable}" (payload) VALUES ($1)`,
              [secondMarker],
            ),
          ),
        ]);
        const [firstRows, secondRows] = await Promise.all([
          runNode(
            databaseQuery(
              firstCredentials.database.url,
              `SELECT payload FROM public."${firstTable}"`,
            ),
          ),
          runNode(
            databaseQuery(
              secondCredentials.database.url,
              `SELECT payload FROM public."${secondTable}"`,
            ),
          ),
        ]);
        expect(firstRows).toEqual([{ payload: firstMarker }]);
        expect(secondRows).toEqual([{ payload: secondMarker }]);
      },
    );
    test(
      `coordinates with an ordinary package stack in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      // oxlint-disable-next-line effecttsgo/async-function -- Vitest callback consumes public PromiseStack contracts.
      async () => {
        const identity = randomId().replaceAll("-", "").slice(0, 16);
        const ordinaryRoot = await runNode(mkdtemp(join(tmpdir(), "supabase-stack-cli-consumer-")));
        let ordinary: PromiseStack | undefined;
        let helper: TestStack | undefined;
        let primary: unknown;
        try {
          ordinary = await createStack({
            projectRoot: ordinaryRoot,
            name: `stack-cli-consumer-${identity}`,
            runtime: mode.runtime,
          });
          const ordinaryStack = ordinary;
          await ordinaryStack.start();
          helper = await createTestStack({
            name: `stack-helper-consumer-${identity}`,
            runtime: mode.runtime,
          });
          const ordinaryStatus = await ordinaryStack.status();
          const helperStatus = await helper.status();
          expect(ordinaryStatus.lifecycle).toBe("running");
          expect(helperStatus.lifecycle).toBe("running");
          expect(helper.stateRoot).toBe(
            (await Effect.runPromise(defaultRuntimeEnvironment)).stateRoot,
          );
          expect(endpoint(ordinaryStatus, "api").port).not.toBe(endpoint(helperStatus, "api").port);
          const scoped = await listStacks({ projectRoot: ordinaryRoot });
          expect(scoped.map(({ id }) => id)).toContain(ordinaryStack.id);
          expect(scoped.map(({ id }) => id)).not.toContain(helper.id);
          const all = await listStacks();
          expect(all.map(({ id }) => id)).toEqual(expect.arrayContaining([ordinary.id, helper.id]));
        } catch (error) {
          primary = error;
        }
        const [helperResult, ordinaryResult] = await Promise.allSettled([
          helper === undefined ? Promise.resolve() : helper[Symbol.asyncDispose](),
          ordinary === undefined ? Promise.resolve() : ordinary.destroy(),
        ]);
        let cleanupFailure: unknown;
        for (const result of [helperResult, ordinaryResult]) {
          if (result.status === "rejected") {
            cleanupFailure ??= result.reason;
          }
        }
        if (ordinaryResult.status === "fulfilled") {
          try {
            await runNode(rm(ordinaryRoot, { recursive: true, force: true }));
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
        if (primary !== undefined) throw primary;
        if (cleanupFailure !== undefined) throw cleanupFailure;
      },
    );
    test(`supports the complete user flow in ${mode.name} mode`, { timeout: E2E_TIMEOUT_MS }, () =>
      runWholeStackScenario(mode),
    );
    test(
      `starts every capability eagerly in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      // oxlint-disable-next-line effecttsgo/async-function -- Vitest callback consumes public PromiseStack contracts.
      async () => {
        const analyticsApiKey = `analytics-key-${randomId()}`;
        await using stack: TestStack = await createTestStack({
          name: `stack-eager-${randomId().replaceAll("-", "").slice(0, 16)}`,
          runtime: mode.runtime,
          config: allEagerConfig(analyticsApiKey),
          setupProject: (root) =>
            runNode(mkdir(join(root, "supabase", "functions"), { recursive: true })),
        });
        const status = await stack.status();
        expect(status.lifecycle).toBe("running");
        expect(status.endpoints.smtp).toBeDefined();
        expect(
          status.capabilities.map(({ name, state, activation }) => ({ name, state, activation })),
        ).toEqual(CAPABILITY_NAMES.map((name) => ({ name, state: "ready", activation: "eager" })));
        await runNode(expectOwnedWorkloads(mode, stack.id, ALL_EAGER_WORKLOAD_IDS));
        const credentials = await stack.credentials();
        expect(await runNode(databaseQuery(credentials.database.url, "SELECT 1 AS value"))).toEqual(
          [{ value: 1 }],
        );
        await stack.stop();
        const stopped = await stack.status();
        expect(stopped.lifecycle).toBe("stopped");
        expect(stopped.capabilities.every(({ state }) => state === "stopped")).toBe(true);
        await runNode(expectOwnedWorkloads(mode, stack.id, []));
      },
    );
    test(
      `supports optional image and vector workloads in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      // oxlint-disable-next-line effecttsgo/async-function -- Vitest callback consumes public PromiseStack contracts.
      async () => {
        const identity = randomId().replaceAll("-", "").slice(0, 20).toLowerCase();
        const bucket = `stack-optional-${identity}`;
        const functionSlug = `optional_${identity}`;
        const analyticsApiKey = `analytics-key-${identity}`;
        const email = `${identity}@example.test`;
        const password = "SupabaseStackE2e!123";
        await using stack: TestStack = await createTestStack({
          name: `stack-optional-${identity}`,
          runtime: mode.runtime,
          config: optionalWorkloadConfig(functionSlug, analyticsApiKey),
          setupProject: (root) =>
            runNode(
              Effect.gen(function* () {
                yield* mkdir(join(root, "supabase", "functions", functionSlug), {
                  recursive: true,
                });
                yield* writeFile(
                  join(root, "supabase", "functions", functionSlug, "index.ts"),
                  "Deno.serve(() => new Response('ok'))",
                );
              }),
            ),
        });
        const credentials = await stack.credentials();
        const status = await stack.status();
        const api = endpoint(status, "api");
        const mailUi = endpoint(status, "mailUi");
        await activate(stack, "storage", () =>
          runNode(
            Effect.gen(function* () {
              yield* request(api.url, "/storage/v1/bucket", {
                method: "POST",
                headers: { ...serviceHeaders(credentials), "content-type": "application/json" },
                body: encodeJson({ id: bucket, name: bucket, public: true }),
              });
              yield* request(api.url, `/storage/v1/object/${bucket}/pixel.png`, {
                method: "POST",
                headers: { ...serviceHeaders(credentials), "content-type": "image/png" },
                body: new Blob([onePixelPng], { type: "image/png" }),
              });
              const transformed = yield* request(
                api.url,
                `/storage/v1/render/image/public/${bucket}/pixel.png?width=1&height=1`,
                { headers: serviceHeaders(credentials) },
              );
              const bytes = yield* Effect.tryPromise(() => transformed.arrayBuffer());
              yield* Effect.sync(() => expect(bytes.byteLength).toBeGreaterThan(0));
            }),
          ),
        );
        await activate(stack, "analytics", () =>
          runNode(
            Effect.gen(function* () {
              yield* request(api.url, "/analytics/v1/health", {
                headers: { "x-api-key": analyticsApiKey },
              });
              const marker = `analytics-${identity}`;
              yield* request(api.url, "/analytics/v1/logs?source_name=postgres.logs", {
                method: "POST",
                headers: { "x-api-key": analyticsApiKey, "content-type": "application/json" },
                body: encodeJson({
                  event_message: marker,
                  project: "default",
                  metadata: { source: "stack-e2e" },
                }),
              });
              const count = yield* queryAnalyticsMarker(api, analyticsApiKey, marker);
              const vectorCount = yield* queryAnalyticsMarker(
                api,
                analyticsApiKey,
                "supabase-stack-vector",
              );
              yield* Effect.sync(() => {
                expect(count).toBeGreaterThan(0);
                expect(vectorCount).toBeGreaterThan(0);
              });
              yield* expectOwnedWorkloads(mode, stack.id, OPTIONAL_STORAGE_ANALYTICS_WORKLOAD_IDS);
            }),
          ),
        );
        await activate(stack, "mail", () =>
          runNode(request(mailUi.url, "/api/v1/messages?limit=100")),
        );
        let signup: JsonObject = {};
        await activate(stack, "auth", () =>
          runNode(
            request(api.url, "/auth/v1/signup", {
              method: "POST",
              headers: { ...apiHeaders(credentials), "content-type": "application/json" },
              body: JSON.stringify({ email, password }),
            }).pipe(
              Effect.flatMap(jsonObject),
              Effect.tap((value) => Effect.sync(() => void (signup = value))),
            ),
          ),
        );
        expect(typeof signup.access_token).toBe("string");
        await runNode(
          request(api.url, "/auth/v1/recover", {
            method: "POST",
            headers: { ...apiHeaders(credentials), "content-type": "application/json" },
            body: JSON.stringify({ email }),
          }),
        );
        const mailAttempt = Effect.gen(function* () {
          const response = yield* request(mailUi.url, "/api/v1/messages?limit=100");
          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) =>
              new E2ERequestError({ message: "Unable to read Mailpit response", cause }),
          });
          if (!body.includes(email))
            return yield* new E2ERequestError({ message: `Mailpit delivery pending for ${email}` });
          return body;
        });
        await runNode(Effect.retry(mailAttempt, { schedule: MAILPIT_DELIVERY_RETRY_SCHEDULE }));
      },
    );
  }
  for (const mode of RUNTIME_CASES) {
    test(
      `releases owned resources across repeated stop/start cycles in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      // oxlint-disable-next-line effecttsgo/async-function -- repeated lifecycle test consumes PromiseStack and AsyncDisposable contracts.
      async () => {
        let stackId: string | undefined;
        let projectRoot = "";
        const snapshots: Array<
          Readonly<{
            containers: number;
            networks: number;
            volumes: number;
          }>
        > = [];
        let endpointSnapshot: ReadonlyArray<StackEndpoint> = [];
        {
          await using stack: TestStack = await createTestStack({
            name: `stack-resource-audit-${randomId().replaceAll("-", "").slice(0, 16)}`,
            runtime: mode.runtime,
            setupProject: (root) => {
              projectRoot = root;
              return Promise.resolve();
            },
          });
          stackId = stack.id;
          const initial = await stack.status();
          expectDefaultLazyState(initial);
          endpointSnapshot = Object.values(initial.endpoints).filter(
            (value): value is StackEndpoint => value !== undefined,
          );
          for (let cycle = 0; cycle < 3; cycle += 1) {
            const stoppedSupervisorPid = await runNode(supervisorPid(stack.id));
            await stack.stop();
            const stopped = await stack.status();
            expect(stopped.lifecycle).toBe("stopped");
            expect(stopped.capabilities.every(({ state }) => state === "stopped")).toBe(true);
            await runNode(expectOwnedWorkloads(mode, stack.id, []));
            await runNode(expectRuntimeInputsAbsent(stack));
            await runNode(expectEndpointsRefused(endpointSnapshot));
            // The stop contract waits for lease/resource release. Detached supervisor exit can
            // lag that handoff, so observe the exact owner PID before scanning for leftovers.
            await runNode(waitForProcessExit(stoppedSupervisorPid));
            expect(await runNode(supervisorPids(stack.id))).toHaveLength(0);
            if (mode.runtime.kind === "container") {
              if (stackId === undefined) throw new Error("Stack id was not assigned");
              snapshots.push({
                containers: await runNode(dockerOwnedResourceCount(stackId, "containers")),
                networks: await runNode(dockerOwnedResourceCount(stackId, "networks")),
                volumes: await runNode(dockerOwnedResourceCount(stackId, "volumes")),
              });
              expect(snapshots.at(-1)).toEqual({ containers: 0, networks: 0, volumes: 1 });
            }
            await stack.start();
            const restarted = await stack.status();
            expectDefaultLazyState(restarted);
            await runNode(expectOwnedWorkloads(mode, stack.id, ["database:database"]));
            expect(
              Object.values(restarted.endpoints).filter(
                (value): value is StackEndpoint => value !== undefined,
              ),
            ).toEqual(endpointSnapshot);
          }
          if (mode.runtime.kind === "container")
            expect(new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))).size).toBe(1);
        }
        expect(projectRoot.length).toBeGreaterThan(0);
        await expect(runNode(access(projectRoot))).rejects.toThrow();
        if (mode.runtime.kind === "container") {
          if (stackId === undefined) throw new Error("Stack id was not assigned");
          expect(await runNode(dockerOwnedResourceCount(stackId, "containers"))).toBe(0);
          expect(await runNode(dockerOwnedResourceCount(stackId, "networks"))).toBe(0);
          expect(await runNode(dockerOwnedResourceCount(stackId, "volumes"))).toBe(0);
        }
        if (stackId === undefined) throw new Error("Stack id was not assigned");
        await runNode(expectOwnedWorkloads(mode, stackId, []));
      },
    );
  }
});
