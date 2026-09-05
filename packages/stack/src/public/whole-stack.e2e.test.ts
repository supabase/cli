// This E2E intentionally exercises the public Promise facade and real host APIs.
// oxlint-disable effecttsgo/async-function -- user-facing Promise facade scenario.
// oxlint-disable effecttsgo/new-promise -- WebSocket event handoff uses the platform Promise API.
// oxlint-disable effecttsgo/global-fetch -- user-shaped HTTP requests use global fetch.
// oxlint-disable effecttsgo/global-timers -- timeout guards belong to the host protocol fixtures.
// oxlint-disable effecttsgo/crypto-random-uuid -- test identities use host randomness.
// oxlint-disable effecttsgo/global-date -- query windows use host timestamps.
// oxlint-disable effecttsgo/node-builtin-import -- E2E setup writes a real project with host fs/path APIs.
import { PgClient } from "@effect/sql-pg";
import { Data, Effect, Redacted, Schedule, type Duration } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { describe, expect, test } from "vitest";
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
const execFile = promisify(execFileCallback);
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
// Test registration must select the CI matrix case before an Effect program exists.
// oxlint-disable-next-line effecttsgo/process-env
const SELECTED_RUNTIME = process.env["SUPABASE_STACK_E2E_RUNTIME"];
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
  "auth:auth",
  "database:database",
  "functions:edge-runtime",
  "mail:mail",
  "pooler:pooler",
  "realtime:realtime",
  "rest:rest",
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

const dockerOwnedResourceCount = async (
  stackId: string,
  kind: "containers" | "networks" | "volumes",
): Promise<number> => {
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
  const result = await execFile("docker", args, { encoding: "utf8" });
  return result.stdout.trim().length === 0 ? 0 : result.stdout.trim().split("\n").length;
};

const dockerOwnedWorkloadIds = async (stackId: string): Promise<ReadonlyArray<string>> => {
  const listed = await execFile(
    "docker",
    ["ps", "-aq", "--filter", `label=com.supabase.stack.stackId=${stackId}`],
    { encoding: "utf8" },
  );
  const ids = listed.stdout
    .trim()
    .split("\n")
    .filter((value) => value.length > 0);
  if (ids.length === 0) return [];
  const inspected = await execFile(
    "docker",
    ["inspect", "--format", '{{index .Config.Labels "com.supabase.stack.workloadId"}}', ...ids],
    { encoding: "utf8" },
  );
  return [
    ...new Set(
      inspected.stdout
        .trim()
        .split("\n")
        .filter((value) => value.length > 0),
    ),
  ].sort();
};

/** Native launchers carry the exact stack/workload marker in their command line. */
const nativeWorkloadIds = async (stackId: string): Promise<ReadonlyArray<string>> => {
  const result = await execFile("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
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
};

const ownedWorkloadIds = async (
  mode: (typeof RUNTIME_CASES)[number],
  stackId: string,
): Promise<ReadonlyArray<string>> =>
  mode.runtime.kind === "container" ? dockerOwnedWorkloadIds(stackId) : nativeWorkloadIds(stackId);

const expectOwnedWorkloads = async (
  mode: (typeof RUNTIME_CASES)[number],
  stackId: string,
  expected: ReadonlyArray<string>,
): Promise<void> => {
  expect(await ownedWorkloadIds(mode, stackId)).toEqual([...expected].sort());
};

const supervisorPids = async (stackId: string): Promise<ReadonlyArray<number>> => {
  const result = await execFile("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match === null) return [];
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    return command.includes(stackId) &&
      (command.includes("supervisor-node.ts") || command.includes("__supabase_stack_supervisor__"))
      ? [pid]
      : [];
  });
};

const supervisorPid = async (stackId: string): Promise<number> => {
  const matches = await supervisorPids(stackId);
  if (matches.length !== 1)
    throw new Error(`Expected one Supervisor process for ${stackId}, found ${matches.length}`);
  const pid = matches[0];
  if (pid === undefined) throw new Error(`Supervisor process for ${stackId} has no PID`);
  return pid;
};

const nativeDatabaseSharedMemoryId = async (lockPath: string): Promise<number> => {
  const lines = (await readFile(lockPath, "utf8")).split("\n");
  const sharedMemoryId = Number(lines[6]?.trim().split(/\s+/u)[1]);
  if (!Number.isSafeInteger(sharedMemoryId) || sharedMemoryId < 0)
    throw new Error("Native database lock did not contain a valid shared-memory ID");
  return sharedMemoryId;
};

const nativeDatabaseSharedMemoryExists = async (
  sharedMemoryId: number,
): Promise<boolean | undefined> => {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  try {
    const result = await execFile("ipcs", ["-m"], { encoding: "utf8" });
    return result.stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/u)[1] === String(sharedMemoryId));
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const waitForProcessExit = (pid: number): Promise<void> => {
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
  return Effect.runPromise(
    Effect.retry(exited, {
      schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "15 seconds" })),
    }),
  );
};

type JsonObject = Record<string, unknown>;

class E2ERequestError extends Data.TaggedError("E2ERequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const request = async (base: string, path: string, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(path, `${base.replace(/\/$/u, "")}/`);
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${method} ${url} failed: ${reason}`, { cause });
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${method} ${url} returned ${response.status}: ${body}`);
  }
  return response;
};

const connect = (endpoint: StackEndpoint): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connectTcp(endpoint.port, endpoint.address);
    const fail = (cause: unknown) => {
      socket.destroy();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", fail);
    socket.setTimeout(2_000, () => fail(new Error("TCP connection timed out")));
  });

const expectEndpointsRefused = async (endpoints: ReadonlyArray<StackEndpoint>): Promise<void> => {
  for (const listener of endpoints) {
    await expect(
      connect(listener),
      `${listener.protocol} ${listener.url} should be closed`,
    ).rejects.toThrow();
  }
};

const expectRuntimeInputsAbsent = async (
  stack: Pick<TestStack, "stateRoot" | "id">,
): Promise<void> => {
  const stackRoot = join(stack.stateRoot, stack.id);
  await access(stackRoot);
  for (const relativePath of ["runtime/env", "runtime/inputs", "runtime/functions"]) {
    const path = join(stackRoot, relativePath);
    try {
      expect(await readdir(path), `${path} should be empty after cleanup`).toHaveLength(0);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
};

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

const jsonValue = async (response: Response): Promise<unknown> => response.json();

const jsonObject = async (response: Response): Promise<JsonObject> => {
  const value = await jsonValue(response);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object response");
  return Object.fromEntries(Object.entries(value));
};

const databaseQuery = async (
  url: string,
  statement: string,
  parameters: ReadonlyArray<unknown> = [],
  options: Readonly<{ readonly connectTimeout?: Duration.Input }> = {},
): Promise<ReadonlyArray<object>> => {
  try {
    return await Effect.runPromise(
      Effect.scoped(
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
      ),
    );
  } catch (cause) {
    let target = "<database>";
    try {
      const parsed = new URL(url);
      target = `${parsed.protocol}//${parsed.hostname}:${parsed.port || "default"}${parsed.pathname}`;
    } catch {
      // Keep diagnostics safe even when the connection URL is malformed.
    }
    throw new Error(`databaseQuery failed for ${target}: ${statement}`, { cause });
  }
};

const apiHeaders = (
  credentials: PromiseStackCredentials,
  token: string = credentials.api.anonJwt,
): Record<string, string> => ({
  apikey: credentials.api.publishableKey,
  Authorization: `Bearer ${token}`,
});

const serviceHeaders = (credentials: PromiseStackCredentials): Record<string, string> =>
  apiHeaders(credentials, credentials.api.serviceRoleJwt);

const functionSource = (table: string, marker: string): string => `
Deno.serve(async () => {
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
): Promise<JsonObject> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener("message", onMessage);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const finish = (error: Error | undefined, value?: JsonObject) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(value ?? {});
      else reject(error);
    };
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for Realtime message")),
      REQUEST_TIMEOUT_MS,
    );
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const value: unknown = JSON.parse(websocketDataText(data));
        if (!isJsonObject(value)) return;
        if (!predicate(value)) return;
        finish(undefined, Object.fromEntries(Object.entries(value)));
      } catch {
        // Ignore protocol frames that are not JSON objects.
      }
    };
    const onError = () => finish(new Error("Realtime WebSocket failed while waiting"));
    const onClose = () => finish(new Error("Realtime WebSocket closed while waiting"));
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      handshakeTimeout: REQUEST_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", (cause) => reject(cause));
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
    analytics: { settings: { vector_port: 9001, api_key: analyticsApiKey } },
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
      settings: { vector_port: 9001, api_key: analyticsApiKey },
    },
    pooler: { activation: "eager" },
  },
  listeners: { smtp: { enabled: true } },
});

const queryAnalyticsMarker = async (
  api: StackEndpoint,
  analyticsApiKey: string,
  marker: string,
): Promise<number> => {
  const query = new URLSearchParams({
    project: "default",
    iso_timestamp_start: new Date(Date.now() - 3_600_000).toISOString(),
    iso_timestamp_end: new Date(Date.now() + 3_600_000).toISOString(),
    sql:
      "select count(*) as c from postgres_logs where regexp_contains(event_message, '" +
      marker +
      "')",
  });
  const attempt = Effect.tryPromise({
    try: async () => {
      const response = await jsonObject(
        await request(api.url, "/analytics/v1/api/endpoints/query/logs.all?" + query, {
          headers: { "x-api-key": analyticsApiKey },
        }),
      );
      const rows = response.result;
      const count = Array.isArray(rows) && isJsonObject(rows[0]) ? Number(rows[0].c) : 0;
      if (count <= 0) throw new Error(`Analytics query pending (count=${count})`);
      return count;
    },
    catch: (cause) =>
      new E2ERequestError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  return Effect.runPromise(Effect.retry(attempt, { schedule: ANALYTICS_QUERY_RETRY_SCHEDULE }));
};

const runWholeStackScenario = async (mode: (typeof RUNTIME_CASES)[number]): Promise<void> => {
  const identity = crypto.randomUUID().replaceAll("-", "").slice(0, 20).toLowerCase();
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
    setupProject: async (root) => {
      projectRoot = root;
      const directory = join(root, "supabase", "functions", functionSlug);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.ts"), functionSource(table, markers.first));
    },
  });

  const initialRunning = await stack.status();
  expect(initialRunning.runtime).toEqual(mode.runtime);
  expect(projectRoot.length).toBeGreaterThan(0);
  expectDefaultLazyState(initialRunning);
  await expectOwnedWorkloads(mode, stack.id, ["database:database"]);

  // Preparation is an explicit cache-only operation. It runs after the helper's
  // initial session is stopped, so the test proves it creates no owner, listener,
  // or workload.
  await stack.stop();
  const warmed = await stack.prepare({ capabilities: ["rest"] });
  expect(warmed.capabilities).toEqual(
    expect.arrayContaining([expect.objectContaining({ capability: "rest" })]),
  );
  expect((await stack.status()).lifecycle).toBe("stopped");
  expect(await supervisorPids(stack.id)).toHaveLength(0);
  await expectEndpointsRefused(
    Object.values(initialRunning.endpoints).filter(
      (value): value is StackEndpoint => value !== undefined,
    ),
  );
  const initial = await stack.start();
  expectDefaultLazyState(initial);
  await expectOwnedWorkloads(mode, stack.id, ["database:database"]);
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

  // Direct SQL creates the table and enables Realtime's publication for it.
  await databaseQuery(
    credentials.database.url,
    `CREATE TABLE public."${table}" (id integer PRIMARY KEY, payload text NOT NULL)`,
  );
  await databaseQuery(
    credentials.database.url,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${table}" TO anon, authenticated, service_role`,
  );
  await databaseQuery(
    credentials.database.url,
    `ALTER PUBLICATION supabase_realtime ADD TABLE public."${table}"`,
  );
  const directRows = await databaseQuery(
    credentials.database.url,
    `INSERT INTO public."${table}" (id, payload) VALUES (1, $1) RETURNING id, payload`,
    [markers.first],
  );
  expect(directRows).toEqual([{ id: 1, payload: markers.first }]);

  // Log following is a filtered, client-polled view over the same retained
  // cursor API. Consume one database entry and explicitly cancel the iterator;
  // no server-side subscription or handle-owned resource is involved.
  expect((await stack.logs({ capabilities: ["database"], tail: 1 })).entries).not.toHaveLength(0);
  const logIterator = stack
    .followLogs({ capabilities: ["database"], tail: 1 })
    [Symbol.asyncIterator]();
  const logEntry = await logIterator.next();
  expect(logEntry.done).toBe(false);
  if (!logEntry.done) expect(logEntry.value.source).toBe("database");
  await logIterator.return?.();

  // PostgREST reads the SQL-created row, then writes through the authenticated user token.
  const restPath = `/rest/v1/${table}?select=id,payload&order=id`;
  let restRows: unknown = undefined;
  await activate(stack, "rest", async () => {
    restRows = await jsonValue(
      await request(api.url, restPath, {
        headers: { ...apiHeaders(credentials), Accept: "application/json" },
      }),
    );
  });
  expect(restRows).toEqual(expect.arrayContaining([{ id: 1, payload: markers.first }]));

  let signup: JsonObject = {};
  await activate(stack, "auth", async () => {
    signup = await jsonObject(
      await request(api.url, "/auth/v1/signup", {
        method: "POST",
        headers: { ...apiHeaders(credentials), "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  });
  const accessToken = signup.access_token;
  expect(typeof accessToken).toBe("string");
  if (typeof accessToken !== "string")
    throw new Error("Auth signup did not return an access token");

  const authenticatedInsert = await jsonValue(
    await request(api.url, `/rest/v1/${table}`, {
      method: "POST",
      headers: {
        ...apiHeaders(credentials, accessToken),
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ id: 2, payload: `auth-${identity}` }),
    }),
  );
  expect(authenticatedInsert).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 2, payload: `auth-${identity}` })]),
  );

  // Realtime receives the next Postgres change over the same public API listener.
  let openedSocket: WebSocket | undefined;
  const socket = await (async (): Promise<WebSocket> => {
    try {
      return await activate(stack, "realtime", async () => {
        const candidate = await openSocket(makeRealtimeUrl(api, credentials.api.publishableKey));
        openedSocket = candidate;
        return candidate;
      });
    } catch (cause) {
      openedSocket?.close();
      throw cause;
    }
  })();
  const socketWaiters: Array<Promise<JsonObject>> = [];
  try {
    const joined = waitForSocket(socket, (value) => {
      const payload = value.payload;
      return value.event === "phx_reply" && typeof payload === "object" && payload !== null;
    });
    socketWaiters.push(joined);
    const subscribed = waitForSocket(socket, (value) => {
      const payload = value.payload;
      return (
        value.event === "system" &&
        isJsonObject(payload) &&
        payload.status === "ok" &&
        payload.extension === "postgres_changes"
      );
    });
    socketWaiters.push(subscribed);
    const change = waitForSocket(socket, (value) => value.event === "postgres_changes");
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
    await request(api.url, `/rest/v1/${table}`, {
      method: "POST",
      headers: {
        ...apiHeaders(credentials, accessToken),
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ id: 3, payload: `realtime-${identity}` }),
    });
    const realtimeChange = await change;
    expect(JSON.stringify(realtimeChange)).toContain(`realtime-${identity}`);
  } finally {
    socket.close();
    await Promise.allSettled(socketWaiters);
  }

  // Storage exercises the lazy Storage workload and its image-transform companion.
  await activate(stack, "storage", async () => {
    await request(api.url, "/storage/v1/bucket", {
      method: "POST",
      headers: { ...serviceHeaders(credentials), "content-type": "application/json" },
      body: JSON.stringify({ id: bucket, name: bucket, public: true }),
    });
    await request(api.url, `/storage/v1/object/${bucket}/pixel.png`, {
      method: "POST",
      headers: { ...serviceHeaders(credentials), "content-type": "image/png" },
      body: new Blob([onePixelPng], { type: "image/png" }),
    });
    const downloaded = await request(api.url, `/storage/v1/object/public/${bucket}/pixel.png`, {
      headers: serviceHeaders(credentials),
    });
    expect((await downloaded.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  // Functions are request-time discovered and call REST through SUPABASE_URL.
  const functionPath = `/functions/v1/${functionSlug}`;
  try {
    let firstFunction: JsonObject = {};
    await activate(stack, "functions", async () => {
      firstFunction = await jsonObject(
        await request(api.url, functionPath, { headers: apiHeaders(credentials) }),
      );
    });
    expect(firstFunction).toEqual(
      expect.objectContaining({
        marker: markers.first,
        functionSlug,
        rows: expect.arrayContaining([{ id: 1, payload: markers.first }]),
      }),
    );
    await writeFile(
      join(projectRoot, "supabase", "functions", functionSlug, "index.ts"),
      functionSource(table, markers.second),
    );
    const secondFunction = await jsonObject(
      await request(api.url, functionPath, { headers: apiHeaders(credentials) }),
    );
    expect(secondFunction).toEqual(
      expect.objectContaining({
        marker: markers.second,
        functionSlug,
        rows: expect.arrayContaining([{ id: 1, payload: markers.first }]),
      }),
    );

    // followLogs is a client-side poller. Capture the current cursor and subscribe
    // before producing a unique console marker through the real edge runtime.
    const beforeLiveLogs = await stack.logs({ capabilities: ["functions"] });
    const liveIterator = stack
      .followLogs({ capabilities: ["functions"], cursor: beforeLiveLogs.cursor })
      [Symbol.asyncIterator]();
    try {
      const liveNext = liveIterator.next();
      await writeFile(
        join(projectRoot, "supabase", "functions", functionSlug, "index.ts"),
        functionSource(table, markers.live),
      );
      await jsonObject(await request(api.url, functionPath, { headers: apiHeaders(credentials) }));
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

  // Mailpit UI traffic lazily activates the mail capability. SMTP delivery is
  // covered by the explicit SMTP configuration scenario below.
  await activate(stack, "mail", async () => {
    await request(mailUi.url, "/api/v1/messages?limit=100");
  });

  // Studio's profile endpoint lazily activates Studio and its transitive dependencies.
  // Analytics is activated first so Studio does not hide that assertion.
  await activate(stack, "analytics", async () => {
    await request(api.url, "/analytics/v1/health");
  });
  try {
    await activate(stack, "studio", async () => {
      await request(studio.url, "/api/platform/profile", {
        headers: serviceHeaders(credentials),
        signal: AbortSignal.timeout(LAZY_STUDIO_ACTIVATION_TIMEOUT_MS),
      });
    });
  } catch (cause) {
    await throwCapabilityDiagnostics(stack, "studio", "Studio profile request", cause);
  }

  // Pooler is a separate public TCP listener over the same database credentials.
  const poolerUrl = new URL(credentials.database.url);
  poolerUrl.port = String(pooler.port);
  poolerUrl.username = "postgres.pooler-dev";
  let poolerRows: ReadonlyArray<object> = [];
  await activate(stack, "pooler", async () => {
    poolerRows = await databaseQuery(poolerUrl.toString(), "SELECT 42 AS answer", [], {
      connectTimeout: LAZY_POOLER_ACTIVATION_TIMEOUT,
    });
  });
  expect(poolerRows).toEqual([{ answer: 42 }]);

  const ready = await stack.status();
  expect(ready.capabilities.map(({ name, state }) => ({ name, state }))).toEqual(
    CAPABILITY_NAMES.map((name) => ({ name, state: "ready" })),
  );
  for (const workloadId of ["studio:pgmeta", "studio:studio"] as const) {
    expect(ready.artifacts).toContainEqual(
      expect.objectContaining({ workloadId, capability: "studio", state: "ready" }),
    );
  }
  await expectOwnedWorkloads(mode, stack.id, BASE_WORKLOAD_IDS);
  const idempotentStart = await stack.start();
  expect(idempotentStart.capabilities.map(({ name, state }) => ({ name, state }))).toEqual(
    CAPABILITY_NAMES.map((name) => ({ name, state: "ready" })),
  );

  const endpointSnapshot = Object.fromEntries(
    Object.entries(ready.endpoints).map(([name, value]) => [name, value?.port]),
  );
  const persistedMarker = await databaseQuery(
    credentials.database.url,
    `SELECT payload FROM public."${table}" WHERE id = 1`,
  );
  expect(persistedMarker).toEqual([{ payload: markers.first }]);
  const volumesBeforeStop =
    mode.runtime.kind === "container"
      ? await dockerOwnedResourceCount(initial.id, "volumes")
      : undefined;

  const reactivate = async (): Promise<void> => {
    await activate(stack, "rest", async () => {
      await request(api.url, restPath, { headers: apiHeaders(credentials) });
    });
    await activate(stack, "auth", async () => {
      await request(api.url, "/auth/v1/settings", { headers: apiHeaders(credentials) });
    });
    await activate(stack, "realtime", async () => {
      const probe = await openSocket(makeRealtimeUrl(api, credentials.api.publishableKey));
      probe.close();
    });
    await activate(stack, "storage", async () => {
      await request(api.url, "/storage/v1/bucket", { headers: serviceHeaders(credentials) });
    });
    await activate(stack, "functions", async () => {
      await request(api.url, functionPath, { headers: apiHeaders(credentials) });
    });
    await activate(stack, "mail", async () => {
      await request(mailUi.url, "/api/v1/messages?limit=1");
    });
    await activate(stack, "analytics", async () => {
      await request(api.url, "/analytics/v1/health");
    });
    await activate(stack, "studio", async () => {
      await request(studio.url, "/api/platform/profile", {
        headers: serviceHeaders(credentials),
        signal: AbortSignal.timeout(LAZY_STUDIO_ACTIVATION_TIMEOUT_MS),
      });
    });
    await activate(stack, "pooler", async () => {
      await databaseQuery(poolerUrl.toString(), "SELECT 42 AS answer", [], {
        connectTimeout: LAZY_POOLER_ACTIVATION_TIMEOUT,
      });
    });
  };

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
  await expectOwnedWorkloads(mode, stack.id, []);
  const retainedLogs: StackLogEntry[] = (await stack.logs()).entries.slice();
  expect(retainedLogs.length).toBeGreaterThan(0);
  await expectRuntimeInputsAbsent(stack);
  await expectEndpointsRefused(initialEndpoints);
  if (mode.runtime.kind === "container") {
    expect(await dockerOwnedResourceCount(initial.id, "containers")).toBe(0);
    expect(await dockerOwnedResourceCount(initial.id, "networks")).toBe(0);
    expect(await dockerOwnedResourceCount(initial.id, "volumes")).toBe(volumesBeforeStop);
  }

  const started = await stack.start();
  expectDefaultLazyState(started);
  await expectOwnedWorkloads(mode, stack.id, ["database:database"]);
  expect(
    Object.fromEntries(
      Object.entries(started.endpoints).map(([name, value]) => [name, value?.port]),
    ),
  ).toEqual(endpointSnapshot);
  expect(
    await databaseQuery(
      credentials.database.url,
      `SELECT payload FROM public."${table}" WHERE id = 1`,
    ),
  ).toEqual([{ payload: markers.first }]);
  await reactivate();

  await stack.stop();
  const restarted = await stack.start();
  expectDefaultLazyState(restarted);
  expect(
    Object.fromEntries(
      Object.entries(restarted.endpoints).map(([name, value]) => [name, value?.port]),
    ),
  ).toEqual(endpointSnapshot);
  expect(
    await databaseQuery(
      credentials.database.url,
      `SELECT payload FROM public."${table}" WHERE id = 1`,
    ),
  ).toEqual([{ payload: markers.first }]);
  await reactivate();

  const final = await stack.status();
  expect(final.capabilities.map(({ name, state }) => ({ name, state }))).toEqual(
    CAPABILITY_NAMES.map((name) => ({ name, state: "ready" })),
  );
  await expectOwnedWorkloads(mode, stack.id, BASE_WORKLOAD_IDS);

  await stack.stop();
  await expectOwnedWorkloads(mode, stack.id, []);
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
    async () => {
      await using stack: TestStack = await createTestStack({
        name: `stack-crash-recovery-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
        runtime: { kind: "native" },
      });
      const before = await stack.status();
      const database = endpoint(before, "database");
      const lockPath = join(stack.stateRoot, stack.id, "data", "database", "postmaster.pid");
      const databasePid = Number((await readFile(lockPath, "utf8")).split("\n", 1)[0]);
      if (!Number.isSafeInteger(databasePid) || databasePid <= 0)
        throw new Error("Native database lock did not contain a valid PID");
      const sharedMemoryId = await nativeDatabaseSharedMemoryId(lockPath);
      const sharedMemoryAvailable = await nativeDatabaseSharedMemoryExists(sharedMemoryId);
      if (sharedMemoryAvailable !== undefined) expect(sharedMemoryAvailable).toBe(true);
      process.kill(await supervisorPid(stack.id), "SIGKILL");
      await waitForProcessExit(databasePid);
      if (sharedMemoryAvailable !== undefined)
        expect(await nativeDatabaseSharedMemoryExists(sharedMemoryId)).toBe(false);
      await expect(connect(database)).rejects.toThrow();
      await expect(access(lockPath)).rejects.toThrow();

      const recovered = await stack.start();
      expectDefaultLazyState(recovered);
      expect(
        await databaseQuery((await stack.credentials()).database.url, "SELECT 1 AS value"),
      ).toEqual([{ value: 1 }]);
    },
  );

  for (const mode of RUNTIME_CASES) {
    for (const databaseVersion of NON_DEFAULT_DATABASE_RELEASES) {
      const major = databaseVersion.split(".")[0];
      test(
        `starts PostgreSQL ${major} in ${mode.name} mode`,
        { timeout: E2E_TIMEOUT_MS },
        async () => {
          await using stack: TestStack = await createTestStack({
            name: `stack-postgres-${major}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
            runtime: mode.runtime,
            config: { capabilities: { database: { version: major } } },
          });
          const rows = await databaseQuery(
            (await stack.credentials()).database.url,
            "SELECT current_setting('server_version') AS version",
          );
          expect(rows).toEqual([{ version: expect.stringMatching(new RegExp(`^${major}\\.`)) }]);
        },
      );
    }

    test(
      `coordinates concurrent isolated stacks in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      async () => {
        const identity = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
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
          databaseQuery(
            firstCredentials.database.url,
            `CREATE TABLE public."${firstTable}" (payload text NOT NULL)`,
          ),
          databaseQuery(
            secondCredentials.database.url,
            `CREATE TABLE public."${secondTable}" (payload text NOT NULL)`,
          ),
        ]);
        await Promise.all([
          databaseQuery(
            firstCredentials.database.url,
            `INSERT INTO public."${firstTable}" (payload) VALUES ($1)`,
            [firstMarker],
          ),
          databaseQuery(
            secondCredentials.database.url,
            `INSERT INTO public."${secondTable}" (payload) VALUES ($1)`,
            [secondMarker],
          ),
        ]);
        const [firstRows, secondRows] = await Promise.all([
          databaseQuery(
            firstCredentials.database.url,
            `SELECT payload FROM public."${firstTable}"`,
          ),
          databaseQuery(
            secondCredentials.database.url,
            `SELECT payload FROM public."${secondTable}"`,
          ),
        ]);
        expect(firstRows).toEqual([{ payload: firstMarker }]);
        expect(secondRows).toEqual([{ payload: secondMarker }]);
      },
    );

    test(
      `coordinates with an ordinary package stack in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      async () => {
        const identity = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
        const ordinaryRoot = await mkdtemp(join(tmpdir(), "supabase-stack-cli-consumer-"));
        let ordinary: PromiseStack | undefined;
        let helper: TestStack | undefined;
        let primary: unknown;
        try {
          ordinary = await createStack({
            projectRoot: ordinaryRoot,
            name: `stack-cli-consumer-${identity}`,
            runtime: mode.runtime,
          });
          await ordinary.start();
          helper = await createTestStack({
            name: `stack-helper-consumer-${identity}`,
            runtime: mode.runtime,
          });

          const ordinaryStatus = await ordinary.status();
          const helperStatus = await helper.status();
          expect(ordinaryStatus.lifecycle).toBe("running");
          expect(helperStatus.lifecycle).toBe("running");
          expect(helper.stateRoot).toBe(defaultRuntimeEnvironment().stateRoot);
          expect(endpoint(ordinaryStatus, "api").port).not.toBe(endpoint(helperStatus, "api").port);

          const scoped = await listStacks({ projectRoot: ordinaryRoot });
          expect(scoped.map(({ id }) => id)).toContain(ordinary.id);
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
            await rm(ordinaryRoot, { recursive: true, force: true });
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
      async () => {
        const analyticsApiKey = `analytics-key-${crypto.randomUUID()}`;
        await using stack: TestStack = await createTestStack({
          name: `stack-eager-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
          runtime: mode.runtime,
          config: allEagerConfig(analyticsApiKey),
          setupProject: async (root) => {
            await mkdir(join(root, "supabase", "functions"), { recursive: true });
          },
        });
        const status = await stack.status();
        expect(status.lifecycle).toBe("running");
        expect(status.endpoints.smtp).toBeDefined();
        expect(
          status.capabilities.map(({ name, state, activation }) => ({ name, state, activation })),
        ).toEqual(CAPABILITY_NAMES.map((name) => ({ name, state: "ready", activation: "eager" })));
        await expectOwnedWorkloads(mode, stack.id, ALL_EAGER_WORKLOAD_IDS);

        const credentials = await stack.credentials();
        expect(await databaseQuery(credentials.database.url, "SELECT 1 AS value")).toEqual([
          { value: 1 },
        ]);

        await stack.stop();
        const stopped = await stack.status();
        expect(stopped.lifecycle).toBe("stopped");
        expect(stopped.capabilities.every(({ state }) => state === "stopped")).toBe(true);
        await expectOwnedWorkloads(mode, stack.id, []);
      },
    );

    test(
      `supports optional image and vector workloads in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      async () => {
        const identity = crypto.randomUUID().replaceAll("-", "").slice(0, 20).toLowerCase();
        const bucket = `stack-optional-${identity}`;
        const functionSlug = `optional_${identity}`;
        const analyticsApiKey = `analytics-key-${identity}`;
        const email = `${identity}@example.test`;
        const password = "SupabaseStackE2e!123";
        await using stack: TestStack = await createTestStack({
          name: `stack-optional-${identity}`,
          runtime: mode.runtime,
          config: optionalWorkloadConfig(functionSlug, analyticsApiKey),
          setupProject: async (root) => {
            await mkdir(join(root, "supabase", "functions", functionSlug), { recursive: true });
            await writeFile(
              join(root, "supabase", "functions", functionSlug, "index.ts"),
              "Deno.serve(() => new Response('ok'))",
            );
          },
        });
        const credentials = await stack.credentials();
        const status = await stack.status();
        const api = endpoint(status, "api");
        const mailUi = endpoint(status, "mailUi");
        await activate(stack, "storage", async () => {
          await request(api.url, "/storage/v1/bucket", {
            method: "POST",
            headers: { ...serviceHeaders(credentials), "content-type": "application/json" },
            body: JSON.stringify({ id: bucket, name: bucket, public: true }),
          });
          await request(api.url, `/storage/v1/object/${bucket}/pixel.png`, {
            method: "POST",
            headers: { ...serviceHeaders(credentials), "content-type": "image/png" },
            body: new Blob([onePixelPng], { type: "image/png" }),
          });
          const transformed = await request(
            api.url,
            `/storage/v1/render/image/public/${bucket}/pixel.png?width=1&height=1`,
            { headers: serviceHeaders(credentials) },
          );
          expect((await transformed.arrayBuffer()).byteLength).toBeGreaterThan(0);
        });
        await activate(stack, "analytics", async () => {
          await request(api.url, "/analytics/v1/health", {
            headers: { "x-api-key": analyticsApiKey },
          });
          const marker = `analytics-${identity}`;
          await request(api.url, "/analytics/v1/logs?source_name=postgres.logs", {
            method: "POST",
            headers: { "x-api-key": analyticsApiKey, "content-type": "application/json" },
            body: JSON.stringify({
              event_message: marker,
              project: "default",
              metadata: { source: "stack-e2e" },
            }),
          });
          expect(await queryAnalyticsMarker(api, analyticsApiKey, marker)).toBeGreaterThan(0);
          expect(
            await queryAnalyticsMarker(api, analyticsApiKey, "supabase-stack-vector"),
          ).toBeGreaterThan(0);
          await expectOwnedWorkloads(mode, stack.id, OPTIONAL_STORAGE_ANALYTICS_WORKLOAD_IDS);
        });
        await activate(stack, "mail", async () => {
          await request(mailUi.url, "/api/v1/messages?limit=100");
        });
        let signup: JsonObject = {};
        await activate(stack, "auth", async () => {
          signup = await jsonObject(
            await request(api.url, "/auth/v1/signup", {
              method: "POST",
              headers: { ...apiHeaders(credentials), "content-type": "application/json" },
              body: JSON.stringify({ email, password }),
            }),
          );
        });
        expect(typeof signup.access_token).toBe("string");
        await request(api.url, "/auth/v1/recover", {
          method: "POST",
          headers: { ...apiHeaders(credentials), "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const mailAttempt = Effect.tryPromise({
          try: async () => {
            const body = await (await request(mailUi.url, "/api/v1/messages?limit=100")).text();
            if (!body.includes(email)) throw new Error(`Mailpit delivery pending for ${email}`);
            return body;
          },
          catch: (cause) =>
            new E2ERequestError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        await Effect.runPromise(
          Effect.retry(mailAttempt, { schedule: MAILPIT_DELIVERY_RETRY_SCHEDULE }),
        );
      },
    );
  }

  for (const mode of RUNTIME_CASES) {
    test(
      `releases owned resources across repeated stop/start cycles in ${mode.name} mode`,
      { timeout: E2E_TIMEOUT_MS },
      async () => {
        let stackId: string | undefined;
        let projectRoot = "";
        const snapshots: Array<
          Readonly<{ containers: number; networks: number; volumes: number }>
        > = [];
        let endpointSnapshot: ReadonlyArray<StackEndpoint> = [];
        {
          await using stack: TestStack = await createTestStack({
            name: `stack-resource-audit-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
            runtime: mode.runtime,
            setupProject: async (root) => {
              projectRoot = root;
            },
          });
          stackId = stack.id;
          const initial = await stack.status();
          expectDefaultLazyState(initial);
          endpointSnapshot = Object.values(initial.endpoints).filter(
            (value): value is StackEndpoint => value !== undefined,
          );
          for (let cycle = 0; cycle < 3; cycle += 1) {
            await stack.stop();
            const stopped = await stack.status();
            expect(stopped.lifecycle).toBe("stopped");
            expect(stopped.capabilities.every(({ state }) => state === "stopped")).toBe(true);
            expect(await supervisorPids(stack.id)).toHaveLength(0);
            await expectOwnedWorkloads(mode, stack.id, []);
            await expectRuntimeInputsAbsent(stack);
            await expectEndpointsRefused(endpointSnapshot);
            if (mode.runtime.kind === "container") {
              if (stackId === undefined) throw new Error("Stack id was not assigned");
              snapshots.push({
                containers: await dockerOwnedResourceCount(stackId, "containers"),
                networks: await dockerOwnedResourceCount(stackId, "networks"),
                volumes: await dockerOwnedResourceCount(stackId, "volumes"),
              });
              expect(snapshots.at(-1)).toEqual({ containers: 0, networks: 0, volumes: 1 });
            }
            await stack.start();
            const restarted = await stack.status();
            expectDefaultLazyState(restarted);
            await expectOwnedWorkloads(mode, stack.id, ["database:database"]);
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
        await expect(access(projectRoot)).rejects.toThrow();
        if (mode.runtime.kind === "container") {
          if (stackId === undefined) throw new Error("Stack id was not assigned");
          expect(await dockerOwnedResourceCount(stackId, "containers")).toBe(0);
          expect(await dockerOwnedResourceCount(stackId, "networks")).toBe(0);
          expect(await dockerOwnedResourceCount(stackId, "volumes")).toBe(0);
        }
        if (stackId === undefined) throw new Error("Stack id was not assigned");
        await expectOwnedWorkloads(mode, stackId, []);
      },
    );
  }
});
