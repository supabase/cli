// This E2E intentionally exercises the public Promise facade and real host APIs.
// oxlint-disable effecttsgo/async-function -- user-facing Promise facade scenario.
// oxlint-disable effecttsgo/new-promise -- WebSocket event handoff uses the platform Promise API.
// oxlint-disable effecttsgo/global-fetch -- user-shaped HTTP requests use global fetch.
// oxlint-disable effecttsgo/global-timers -- timeout guards belong to the host protocol fixtures.
// oxlint-disable effecttsgo/crypto-random-uuid -- test identities use host randomness.
// oxlint-disable effecttsgo/global-date -- query windows use host timestamps.
// oxlint-disable effecttsgo/node-builtin-import -- E2E setup writes a real project with host fs/path APIs.
import { PgClient } from "@effect/sql-pg";
import { Data, Effect, Redacted, Schedule } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createTestStack, type TestStack } from "../testing.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import type { PromiseStackCredentials } from "./Credentials.ts";
import type { PromiseStackConfig } from "./PromiseStack.ts";
import type { StackEndpoint, StackStatus } from "./Status.ts";

const E2E_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const ANALYTICS_QUERY_RETRY_SCHEDULE = Schedule.spaced("1 second").pipe(
  Schedule.upTo({ duration: "3 minutes" }),
);
const MAILPIT_DELIVERY_RETRY_SCHEDULE = Schedule.spaced("250 millis").pipe(
  Schedule.upTo({ duration: "30 seconds" }),
);
const RUNTIME_CASES = [
  { name: "native", runtime: { kind: "native" as const } },
  { name: "Docker", runtime: { kind: "container" as const, engine: "docker" as const } },
] as const;

type JsonObject = Record<string, unknown>;

class E2ERequestError extends Data.TaggedError("E2ERequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const endpoint = (status: StackStatus, name: keyof StackStatus["endpoints"]): StackEndpoint => {
  const value = status.endpoints[name];
  if (value === undefined) throw new Error(`Expected ${name} listener in stack status`);
  return value;
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
): Promise<ReadonlyArray<object>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        return yield* client.unsafe(statement, parameters);
      }).pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(url),
            connectTimeout: "10 seconds",
          }),
        ),
      ),
    ),
  );

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
  return new Response(JSON.stringify({ marker: "${marker}", rows: JSON.parse(body) }), {
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
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
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
    const onMessage = (event: MessageEvent) => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (!isJsonObject(value)) return;
        if (!predicate(value)) return;
        finish(undefined, Object.fromEntries(Object.entries(value)));
      } catch {
        // Ignore protocol frames that are not JSON objects.
      }
    };
    const onError = () => finish(new Error("Realtime WebSocket failed while waiting"));
    const onClose = () => finish(new Error("Realtime WebSocket closed while waiting"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out opening Realtime WebSocket"));
    }, REQUEST_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Realtime WebSocket failed to open"));
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

const stackConfig = (functionSlug: string, analyticsApiKey: string): PromiseStackConfig => ({
  capabilities: {
    database: { version: "17.6.1.167" },
    rest: { enabled: true, activation: "lazy" },
    auth: {
      enabled: true,
      settings: {
        enable_signup: true,
        email: { enable_signup: true, enable_confirmations: false },
      },
    },
    realtime: { enabled: true },
    storage: { enabled: true, settings: { image_transformation: { enabled: true } } },
    functions: {
      enabled: true,
      settings: {
        functions_root: "supabase/functions",
        functions: { [functionSlug]: { enabled: true, verify_jwt: false } },
      },
    },
    studio: { enabled: true, activation: "lazy" },
    mail: { enabled: true },
    analytics: { enabled: true, settings: { vector_port: 9001, api_key: analyticsApiKey } },
    pooler: { enabled: true },
  },
  listeners: {
    api: { enabled: true },
    database: { enabled: true },
    pooler: { enabled: true },
    studio: { enabled: true },
    mailUi: { enabled: true },
    smtp: { enabled: true },
    pop3: { enabled: true },
    functionsInspector: { enabled: true },
  },
});

const queryAnalyticsMarker = async (
  api: StackEndpoint,
  analyticsApiKey: string,
  marker: string,
): Promise<{ readonly count: number; readonly response?: JsonObject; readonly error?: string }> => {
  const query = new URLSearchParams({
    project: "default",
    iso_timestamp_start: new Date(Date.now() - 3_600_000).toISOString(),
    iso_timestamp_end: new Date(Date.now() + 3_600_000).toISOString(),
    sql:
      "select count(*) as c from postgres_logs where regexp_contains(event_message, '" +
      marker +
      "')",
  });
  let response: JsonObject | undefined;
  let lastError: string | undefined;
  const attempt = Effect.tryPromise({
    try: async () => {
      response = await jsonObject(
        await request(api.url, "/analytics/v1/api/endpoints/query/logs.all?" + query, {
          headers: { "x-api-key": analyticsApiKey },
        }),
      );
      const rows = response.result;
      const count = Array.isArray(rows) && isJsonObject(rows[0]) ? Number(rows[0].c) : 0;
      if (count <= 0) throw new Error("Analytics query pending (count=" + count + ")");
      return response;
    },
    catch: (cause) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      lastError = reason;
      return new E2ERequestError({ message: reason, cause });
    },
  });
  try {
    await Effect.runPromise(Effect.retry(attempt, { schedule: ANALYTICS_QUERY_RETRY_SCHEDULE }));
  } catch {
    // The returned diagnostics identify the final response and error.
  }
  const rows = response?.result;
  const count = Array.isArray(rows) && isJsonObject(rows[0]) ? Number(rows[0].c) : 0;
  return {
    count,
    ...(response === undefined ? {} : { response }),
    ...(lastError === undefined ? {} : { error: lastError }),
  };
};

const runWholeStackScenario = async (mode: (typeof RUNTIME_CASES)[number]): Promise<void> => {
  const identity = crypto.randomUUID().replaceAll("-", "").slice(0, 20).toLowerCase();
  const table = `stack_e2e_${identity}`;
  const bucket = `stack-e2e-${identity}`;
  const functionSlug = `cross_service_${identity}`;
  const email = `${identity}@example.test`;
  const password = "SupabaseStackE2e!123";
  const markers = { first: `first-${identity}`, second: `second-${identity}` };
  const analyticsApiKey = `analytics-key-${identity}`;
  let projectRoot = "";

  await using stack: TestStack = await createTestStack({
    name: `stack-e2e-${identity}`,
    runtime: mode.runtime,
    config: stackConfig(functionSlug, analyticsApiKey),
    setupProject: async (root) => {
      projectRoot = root;
      const directory = join(root, "supabase", "functions", functionSlug);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.ts"), functionSource(table, markers.first));
    },
  });

  const credentials = await stack.credentials();
  const initial = await stack.status();
  const api = endpoint(initial, "api");
  const pooler = endpoint(initial, "pooler");
  const studio = endpoint(initial, "studio");
  const mailUi = endpoint(initial, "mailUi");

  expect(initial.runtime).toEqual(mode.runtime);
  expect(projectRoot.length).toBeGreaterThan(0);
  expect(initial.capabilities.find(({ name }) => name === "rest")?.state).toBe("dormant");
  expect(initial.capabilities.find(({ name }) => name === "studio")?.state).toBe("dormant");

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

  // PostgREST reads the SQL-created row, then writes through the authenticated user token.
  const restPath = `/rest/v1/${table}?select=id,payload&order=id`;
  const restRows = await jsonValue(
    await request(api.url, restPath, {
      headers: { ...apiHeaders(credentials), Accept: "application/json" },
    }),
  );
  expect(restRows).toEqual(expect.arrayContaining([{ id: 1, payload: markers.first }]));

  const signup = await jsonObject(
    await request(api.url, "/auth/v1/signup", {
      method: "POST",
      headers: { ...apiHeaders(credentials), "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
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
  const socket = await openSocket(makeRealtimeUrl(api, credentials.api.publishableKey));
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
  const transformed = await request(
    api.url,
    `/storage/v1/render/image/public/${bucket}/pixel.png?width=1&height=1`,
    { headers: serviceHeaders(credentials) },
  );
  expect((await transformed.arrayBuffer()).byteLength).toBeGreaterThan(0);

  // Functions are request-time discovered and call REST through SUPABASE_URL.
  const functionPath = `/functions/v1/${functionSlug}`;
  const firstFunction = await jsonObject(
    await request(api.url, functionPath, { headers: apiHeaders(credentials) }),
  );
  expect(firstFunction).toEqual(
    expect.objectContaining({
      marker: markers.first,
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
      rows: expect.arrayContaining([{ id: 1, payload: markers.first }]),
    }),
  );

  // Recovery email traverses Auth → SMTP → Mailpit, then is observable via Mailpit's API.
  await request(api.url, "/auth/v1/recover", {
    method: "POST",
    headers: { ...apiHeaders(credentials), "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const mailAttempt = Effect.tryPromise({
    try: async () => {
      const messages = await request(mailUi.url, "/api/v1/messages?limit=100");
      const body = await messages.text();
      if (!body.includes(email)) throw new Error(`Mailpit delivery pending for ${email}`);
      return body;
    },
    catch: (cause) =>
      new E2ERequestError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  await Effect.runPromise(Effect.retry(mailAttempt, { schedule: MAILPIT_DELIVERY_RETRY_SCHEDULE }));

  // Studio's profile endpoint traverses the Studio workload and its pgmeta dependency.
  await request(studio.url, "/api/platform/profile", {
    headers: serviceHeaders(credentials),
  });

  // Analytics exercises health, authenticated ingestion, and query through the public API route;
  // vector is a readiness dependency selected by the configured vector_port above.
  await request(api.url, "/analytics/v1/health");
  const analyticsMarker = `analytics-${identity}`;
  await request(api.url, "/analytics/v1/logs?source_name=postgres.logs", {
    method: "POST",
    headers: { "x-api-key": analyticsApiKey, "content-type": "application/json" },
    body: JSON.stringify({
      event_message: analyticsMarker,
      project: "default",
      metadata: { source: "stack-e2e" },
    }),
  });
  const analyticsResult = await queryAnalyticsMarker(api, analyticsApiKey, analyticsMarker);
  expect(
    analyticsResult.count,
    `Analytics query did not observe ${analyticsMarker}; last response: ${JSON.stringify(analyticsResult.response ?? null)}; last error: ${analyticsResult.error ?? "none"}`,
  ).toBeGreaterThan(0);
  const vectorResult = await queryAnalyticsMarker(api, analyticsApiKey, "supabase-stack-vector");
  expect(
    vectorResult.count,
    `Analytics query did not observe Vector marker; last response: ${JSON.stringify(vectorResult.response ?? null)}; last error: ${vectorResult.error ?? "none"}`,
  ).toBeGreaterThan(0);

  // Pooler is a separate public TCP listener over the same database credentials.
  const poolerUrl = new URL(credentials.database.url);
  poolerUrl.port = String(pooler.port);
  poolerUrl.username = "postgres.pooler-dev";
  const poolerRows = await databaseQuery(poolerUrl.toString(), "SELECT 42 AS answer");
  expect(poolerRows).toEqual([{ answer: 42 }]);

  const final = await stack.status();
  expect(final.capabilities.map(({ name, state }) => ({ name, state }))).toEqual(
    CAPABILITY_NAMES.map((name) => ({ name, state: "ready" })),
  );
};

describe("managed Supabase stack whole-stack E2E", () => {
  for (const mode of RUNTIME_CASES) {
    test(`supports the complete user flow in ${mode.name} mode`, { timeout: E2E_TIMEOUT_MS }, () =>
      runWholeStackScenario(mode),
    );
  }
});
