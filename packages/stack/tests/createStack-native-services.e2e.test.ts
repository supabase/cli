// oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-fetch, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/process-env -- Native e2e tests await subprocess-backed stack operations and inspect exact temporary roots.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createStack,
  prefetch,
  type LogEntry,
  type ResolvedFunctionsBundle,
  type StackHandle,
} from "@supabase/stack";
import { fetchFunctionWhenReady, setupTestTable } from "./helpers/e2e.ts";

const NATIVE_SERVICES = [
  "postgres",
  "postgrest",
  "auth",
  "edge-runtime",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
] as const;

const JWT_SECRET = "native-services-e2e-jwt-secret-with-at-least-32-characters";
const EDGE_LOG_MARKER = "native-services-vector-marker";

const tinyPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const codeSafeJson = (value: string): string =>
  JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

const writeFunction = (projectDir: string, slug: string, body: string): string => {
  const entrypointPath = join(projectDir, "supabase", "functions", slug, "index.ts");
  mkdirSync(join(projectDir, "supabase", "functions", slug), { recursive: true });
  writeFileSync(
    entrypointPath,
    `Deno.serve(() => { console.log(${codeSafeJson(EDGE_LOG_MARKER)}); return new Response(${codeSafeJson(body)}); });\n`,
    "utf8",
  );
  return entrypointPath;
};

const functionsBundle = (projectDir: string): ResolvedFunctionsBundle => ({
  env: {},
  functions: [
    {
      name: "native-services",
      verifyJWT: false,
      entrypointPath: writeFunction(projectDir, "native-services", "native services ready"),
      importMapPath: null,
      staticFiles: [],
      env: {},
    },
  ],
});

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") !== "ESRCH";
  }
};

const stagingEntries = (root: string): ReadonlyArray<string> => {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.includes(".partial-") || entry.name.includes(".publication-lock"))
      found.push(path);
    if (entry.isDirectory()) found.push(...stagingEntries(path));
  }
  return found;
};

interface SmtpSession {
  readonly socket: Socket;
  readonly nextResponse: () => Promise<string>;
}

const openSmtp = async (port: number): Promise<SmtpSession> => {
  const socket = createConnection({ host: "127.0.0.1", port });
  let buffer = "";
  let responseLines: string[] = [];
  let waiter: { resolve: (response: string) => void; reject: (error: Error) => void } | undefined;

  const parse = (): void => {
    while (waiter !== undefined) {
      const newline = buffer.indexOf("\r\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      responseLines.push(line);
      if (/^\d{3} /.test(line)) {
        const current = waiter;
        waiter = undefined;
        const response = responseLines.join("\n");
        responseLines = [];
        current.resolve(response);
      }
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    parse();
  });
  const rejectPending = (error: Error): void => {
    waiter?.reject(error);
    waiter = undefined;
  };
  socket.once("error", rejectPending);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    nextResponse: () =>
      new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject };
        parse();
      }),
  };
};

const smtpSend = async (port: number, from: string, to: string, subject: string): Promise<void> => {
  const session = await openSmtp(port);
  const command = async (line: string): Promise<string> => {
    session.socket.write(`${line}\r\n`);
    return session.nextResponse();
  };
  try {
    expect((await session.nextResponse()).startsWith("220")).toBe(true);
    expect((await command("EHLO localhost")).startsWith("250")).toBe(true);
    expect((await command(`MAIL FROM:<${from}>`)).startsWith("250")).toBe(true);
    expect((await command(`RCPT TO:<${to}>`)).startsWith("250")).toBe(true);
    expect((await command("DATA")).startsWith("354")).toBe(true);
    session.socket.write(
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nnative services mail\r\n.\r\n`,
    );
    expect((await session.nextResponse()).startsWith("250")).toBe(true);
    expect((await command("QUIT")).startsWith("221")).toBe(true);
  } finally {
    session.socket.destroy();
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const endpointPort = (endpoint: string): number => {
  const port = Number(new URL(endpoint).port);
  if (!Number.isInteger(port) || port < 1)
    throw new Error(`Endpoint has no usable port: ${endpoint}`);
  return port;
};

const requiredEndpoint = (endpoints: Readonly<Record<string, string>>, name: string): string => {
  const endpoint = endpoints[name];
  if (endpoint === undefined) throw new Error(`Published endpoint is missing: ${name}`);
  return endpoint;
};

const withTimeout = async <A>(
  promise: Promise<A>,
  phase: string,
  timeoutMs = 60_000,
): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out during ${phase} after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const DIAGNOSTIC_LOG_LIMIT = 20;
const DIAGNOSTIC_LINE_LIMIT = 2_000;
const REALTIME_CLIENT_LOG_LIMIT = 30;
const REALTIME_CLIENT_PAYLOAD_LIMIT = 400;

interface JourneyDiagnostics {
  readonly stop: () => Promise<void>;
  readonly format: () => string;
}

interface RealtimeClientDiagnostics {
  readonly log: (kind: string, message: string, data?: unknown) => void;
  readonly format: () => string;
}

const closeDiagnosticIterator = async <A>(iterator: AsyncIterator<A>): Promise<void> => {
  try {
    await iterator.return?.();
  } catch (error) {
    if (error instanceof Error && error.message === "All fibers interrupted without error") return;
    throw error;
  }
};

const REALTIME_SECRET_KEY = /authorization|access[_-]?token|api[_-]?key|apikey|jwt|secret|token/i;

const redactRealtimeClientText = (value: string): string =>
  value
    .replace(
      /([?&](?:access_token|apikey|authorization|key|secret|token)=)[^&\s]*/gi,
      "$1<redacted>",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/g, "<key>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt>");

const redactRealtimeClientData = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "<truncated>";
  if (typeof value === "string") return redactRealtimeClientText(value);
  if (Array.isArray(value)) return value.map((item) => redactRealtimeClientData(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REALTIME_SECRET_KEY.test(key) ? "<redacted>" : redactRealtimeClientData(item, depth + 1),
    ]),
  );
};

const collectRealtimeClientDiagnostics = (): RealtimeClientDiagnostics => {
  const entries: string[] = [];
  return {
    log: (kind, message, data) => {
      let line = redactRealtimeClientText(`${kind}: ${message}`);
      if (data !== undefined) {
        try {
          line += ` ${JSON.stringify(redactRealtimeClientData(data))}`;
        } catch {
          line += " <unserializable>";
        }
      }
      entries.push(
        line.length > REALTIME_CLIENT_PAYLOAD_LIMIT
          ? `${line.slice(0, REALTIME_CLIENT_PAYLOAD_LIMIT)}…`
          : line,
      );
      if (entries.length > REALTIME_CLIENT_LOG_LIMIT) entries.shift();
    },
    format: () => `realtime-client=${JSON.stringify(entries)}`,
  };
};

type JourneyServiceState = Awaited<ReturnType<StackHandle["getStatus"]>>[number];

const collectJourneyDiagnostics = (handle: StackHandle): JourneyDiagnostics => {
  const states = new Map<string, JourneyServiceState>();
  const logs = new Map<string, Array<LogEntry>>();
  const statusIterator = handle.statusChanges()[Symbol.asyncIterator]();
  const logIterator = handle.logs()[Symbol.asyncIterator]();
  let stopPromise: Promise<void> | undefined;

  const readStatuses = (async (): Promise<void> => {
    try {
      for (;;) {
        const next = await statusIterator.next();
        if (next.done) return;
        states.set(next.value.name, next.value);
      }
    } catch {
      // Disposal closes the public stream; diagnostics collected before then remain useful.
    }
  })();
  const readLogs = (async (): Promise<void> => {
    try {
      for (;;) {
        const next = await logIterator.next();
        if (next.done) return;
        const entries = logs.get(next.value.service) ?? [];
        entries.push({
          ...next.value,
          line:
            next.value.line.length > DIAGNOSTIC_LINE_LIMIT
              ? `${next.value.line.slice(0, DIAGNOSTIC_LINE_LIMIT)}…`
              : next.value.line,
        });
        if (entries.length > DIAGNOSTIC_LOG_LIMIT) entries.shift();
        logs.set(next.value.service, entries);
      }
    } catch {
      // Disposal closes the public stream; diagnostics collected before then remain useful.
    }
  })();

  return {
    stop: () => {
      if (stopPromise === undefined) {
        stopPromise = (async () => {
          await Promise.all([
            closeDiagnosticIterator(statusIterator),
            closeDiagnosticIterator(logIterator),
          ]);
          await Promise.all([readStatuses, readLogs]);
        })();
      }
      return stopPromise;
    },
    format: () => {
      const serviceLogs = [...logs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([service, entries]) =>
          [...entries].reverse().map((entry) => `log[${service}]=${JSON.stringify(entry)}`),
        );
      return [`status=${JSON.stringify([...states.values()])}`, ...serviceLogs].join("\n");
    },
  };
};

describe("native remaining service graph", () => {
  let stack: StackHandle;
  let supabase: SupabaseClient;
  let projectDir: string;
  let dataDir: string;
  let storageDataDir: string;
  let cacheRoot: string;
  let stackRoot: string;
  let runtimeRoot: string;
  let sentinelBin: string;
  let sentinelMarker: string;
  let originalPath: string | undefined;
  let ownedPids: ReadonlyArray<number> = [];
  let journeyDiagnostics: JourneyDiagnostics | undefined;
  let stackDisposed = false;

  const disposeStack = async (): Promise<void> => {
    if (stackDisposed || stack === undefined) return;
    stackDisposed = true;
    await stack.dispose();
  };

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-native-services-project-"));
    dataDir = mkdtempSync(join(tmpdir(), "supabase-native-services-postgres-"));
    storageDataDir = mkdtempSync(join(tmpdir(), "supabase-native-services-storage-"));
    cacheRoot = mkdtempSync(join(tmpdir(), "supabase-native-services-cache-"));
    stackRoot = mkdtempSync(join(tmpdir(), "supabase-native-services-stack-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "supabase-native-services-runtime-"));
    sentinelBin = mkdtempSync(join(tmpdir(), "supabase-native-services-sentinel-"));
    sentinelMarker = join(sentinelBin, "invoked");
    originalPath = process.env.PATH;
    for (const executable of ["docker", "podman"]) {
      const path = join(sentinelBin, executable);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$0" >> "${sentinelMarker}"\n`, "utf8");
      chmodSync(path, 0o755);
    }
    process.env.PATH = [sentinelBin, originalPath].filter((value) => value !== undefined).join(":");

    await prefetch({ mode: "native", cacheRoot, services: NATIVE_SERVICES });
    stack = await createStack({
      mode: "native",
      cacheRoot,
      stackRoot,
      runtimeRoot,
      projectDir,
      functions: functionsBundle(projectDir),
      jwtSecret: JWT_SECRET,
      readiness: { mode: "finite", timeoutMs: 900_000 },
      servicePolicies: {
        postgres: "eager",
        postgrest: "lazy",
        auth: "lazy",
        "edge-runtime": "lazy",
        realtime: "lazy",
        storage: "lazy",
        imgproxy: "lazy",
        mailpit: "eager",
        pgmeta: "eager",
        studio: "eager",
        analytics: "eager",
        vector: "eager",
        pooler: "eager",
      },
      postgres: { dataDir },
      postgrest: {},
      auth: {},
      edgeRuntime: {},
      realtime: {},
      storage: { dataDir: storageDataDir },
      imgproxy: {},
      mailpit: {},
      pgmeta: {},
      studio: {},
      analytics: { apiKey: "native-services-analytics-key" },
      vector: {},
      pooler: {},
    });

    journeyDiagnostics = collectJourneyDiagnostics(stack);
    try {
      await stack.start();
    } catch (error) {
      const diagnostics = journeyDiagnostics.format();
      await journeyDiagnostics.stop();
      await disposeStack().catch(() => {});
      throw new Error(`Native stack startup failed: ${String(error)}\n${diagnostics}`, {
        cause: error,
      });
    }
    supabase = createClient(stack.url, stack.publishableKey);
    await setupTestTable(Number(new URL(stack.dbUrl).port));
  }, 1_200_000);

  afterAll(async () => {
    try {
      await journeyDiagnostics?.stop();
      if (stack !== undefined) {
        const states = await stack.getStatus().catch(() => []);
        ownedPids = states.flatMap((state) => (state.pid === null ? [] : [state.pid]));
        await disposeStack();
        for (const pid of ownedPids) expect(isProcessAlive(pid)).toBe(false);
      }
      expect(existsSync(sentinelMarker)).toBe(false);
      expect(stagingEntries(cacheRoot)).toEqual([]);
      expect(stagingEntries(stackRoot)).toEqual([]);
      expect(stagingEntries(runtimeRoot)).toEqual([]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      for (const root of [
        dataDir,
        storageDataDir,
        cacheRoot,
        stackRoot,
        runtimeRoot,
        projectDir,
        sentinelBin,
      ]) {
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
      }
    }
  }, 180_000);

  test(
    "qualifies the complete native graph through public Edge, Realtime, Storage, Analytics, Mailpit, and Pooler journeys",
    { timeout: 1_200_000 },
    async () => {
      let phase = "initial stack status";
      let realtimeClientDiagnostics: RealtimeClientDiagnostics | undefined;
      try {
        const initialStates = await stack.getStatus();
        expect(initialStates.map((state) => state.name).toSorted()).toEqual(
          [...NATIVE_SERVICES].toSorted(),
        );
        expect(
          initialStates.filter((state) => state.status === "Healthy").map((state) => state.name),
        ).toEqual(
          expect.arrayContaining([
            "postgres",
            "mailpit",
            "pgmeta",
            "studio",
            "analytics",
            "vector",
            "pooler",
          ]),
        );
        expect(initialStates.find((state) => state.name === "realtime")?.status).toBe("Dormant");
        expect(existsSync(sentinelMarker)).toBe(false);

        phase = "Auth settings";
        const authSettings = await fetch(`${stack.url}/auth/v1/settings`, {
          headers: { apikey: stack.publishableKey },
        });
        expect(authSettings.status).toBe(200);
        await authSettings.arrayBuffer();

        phase = "Edge Function invocation";
        const functionResponse = await fetchFunctionWhenReady(
          `${stack.url}/functions/v1/native-services`,
        );
        expect(functionResponse.status).toBe(200);
        expect(await functionResponse.text()).toBe("native services ready");

        phase = "PostgREST query";
        const postgrestTable = await supabase.from("todos").select("id").limit(1);
        expect(postgrestTable.error).toBeNull();

        phase = "Realtime publication setup";
        const sql = new Bun.SQL(stack.dbUrl);
        try {
          await sql.unsafe(`
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'todos'
            ) THEN
              ALTER PUBLICATION supabase_realtime ADD TABLE public.todos;
            END IF;
          END $$;
        `);
        } finally {
          await sql.close();
        }

        phase = "Realtime database change";
        realtimeClientDiagnostics = collectRealtimeClientDiagnostics();
        const realtime = createClient(stack.url, stack.publishableKey, {
          realtime: { timeout: 60_000, logger: realtimeClientDiagnostics.log },
        });
        let realtimeChannel: ReturnType<typeof realtime.channel> | undefined;
        let insertStarted = false;
        const realtimeChange = new Promise<unknown>((resolve, reject) => {
          const insert = () => {
            if (insertStarted) return;
            insertStarted = true;
            const sql = new Bun.SQL(stack.dbUrl);
            void sql
              .unsafe(
                `INSERT INTO public.todos (title, completed) VALUES ('native-realtime', false)`,
              )
              .then(() => sql.close())
              .catch(async (error: unknown) => {
                await sql.close();
                reject(error instanceof Error ? error : new Error(String(error)));
              });
          };
          realtimeChannel = realtime
            .channel("native-services-todos")
            .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "todos" },
              (payload) => resolve(payload),
            )
            .on(
              "system",
              {},
              (payload: {
                readonly extension: string;
                readonly status: string;
                readonly message: string;
                readonly channel: string;
              }) => {
                if (payload.status === "error") {
                  reject(new Error(`Realtime PostgreSQL readiness failed: ${payload.message}`));
                } else if (payload.extension === "postgres_changes" && payload.status === "ok") {
                  insert();
                }
              },
            )
            .subscribe((status) => {
              if (status !== "SUBSCRIBED") {
                if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                  reject(new Error(`Realtime subscription status: ${status}`));
                }
                return;
              }
            });
        });
        try {
          const change = await withTimeout(realtimeChange, "Realtime database change", 90_000);
          expect(change).toEqual(
            expect.objectContaining({
              eventType: "INSERT",
              table: "todos",
              schema: "public",
            }),
          );
        } finally {
          if (realtimeChannel !== undefined) await realtime.removeChannel(realtimeChannel);
        }

        phase = "Storage image journey";
        const bucket = `native-services-${Date.now()}`;
        const storageAdmin = createClient(stack.url, stack.secretKey);
        const createdBucket = await storageAdmin.storage.createBucket(bucket, { public: true });
        expect(createdBucket.error).toBeNull();
        const uploaded = await storageAdmin.storage
          .from(bucket)
          .upload("tiny.png", new Blob([tinyPng], { type: "image/png" }), {
            contentType: "image/png",
            upsert: true,
          });
        expect(uploaded.error).toBeNull();
        const downloaded = await supabase.storage.from(bucket).download("tiny.png");
        expect(downloaded.error).toBeNull();
        expect(downloaded.data).not.toBeNull();
        expect(new Uint8Array(await downloaded.data!.arrayBuffer())).toEqual(tinyPng);
        const transformed = await fetch(
          `${stack.url}/storage/v1/render/image/public/${bucket}/tiny.png?width=2&height=2`,
        );
        expect(transformed.status).toBe(200);
        expect(transformed.headers.get("content-type")).toMatch(/^image\//);
        expect((await transformed.arrayBuffer()).byteLength).toBeGreaterThan(0);

        phase = "PgMeta, Studio, and Analytics health";
        const pgmeta = await fetch(`${stack.url}/pg/health`);
        expect(pgmeta.status).toBe(200);
        await pgmeta.arrayBuffer();
        const studio = await fetch(
          `${requiredEndpoint(stack.serviceEndpoints, "studio")}/api/platform/profile`,
        );
        expect(studio.status).toBe(200);
        await studio.arrayBuffer();
        const analytics = await fetch(`${stack.url}/analytics/v1/health`);
        expect(analytics.status).toBe(200);
        await analytics.arrayBuffer();

        phase = "Mailpit delivery";
        const recipient = `native-services-${Date.now()}@example.com`;
        await smtpSend(
          endpointPort(requiredEndpoint(stack.serviceEndpoints, "mailpit_smtp")),
          "sender@example.com",
          recipient,
          "native services",
        );
        const mailpitResponse = await fetch(
          `${requiredEndpoint(stack.serviceEndpoints, "mailpit")}/api/v1/messages`,
        );
        expect(mailpitResponse.status).toBe(200);
        const mailpitBody = await readJson(mailpitResponse);
        const mailpitMessages =
          typeof mailpitBody === "object" && mailpitBody !== null
            ? Reflect.get(mailpitBody, "messages")
            : undefined;
        expect(Array.isArray(mailpitMessages)).toBe(true);
        expect(JSON.stringify(mailpitBody)).toContain(recipient);

        phase = "Pooler query";
        const pooled = new Bun.SQL(requiredEndpoint(stack.serviceEndpoints, "pooler"));
        try {
          const rows = await pooled.unsafe<{ answer: number }[]>("SELECT 40 + 2 AS answer");
          expect(rows[0]?.answer).toBe(42);
        } finally {
          await pooled.close();
        }

        const triggerId = String(Date.now());
        const triggerName = `native_vector_trigger_${triggerId}`;
        const functionName = `native_vector_notify_${triggerId}`;
        const channel = `native_vector_${triggerId}`;
        const analyticsDbUrl = new URL(stack.dbUrl);
        analyticsDbUrl.pathname = "/_supabase";
        const analyticsSql = new Bun.SQL(analyticsDbUrl.toString());
        let physicalTable: string | undefined;
        let sourceToken: string | undefined;
        let notificationSubscription: Awaited<ReturnType<typeof analyticsSql.listen>> | undefined;
        let notificationResolve: ((payload: string) => void) | undefined;
        try {
          phase = "Analytics source setup";
          const sourceRows = await analyticsSql.unsafe<{ token: string }[]>(`
            SELECT token::text AS token
            FROM _analytics.sources
            WHERE name = 'postgres.logs'
          `);
          sourceToken = sourceRows.length === 1 ? sourceRows[0]?.token : undefined;
          if (typeof sourceToken !== "string" || !/^[0-9a-f-]+$/i.test(sourceToken)) {
            throw new Error("Analytics postgres.logs source token is invalid");
          }
          physicalTable = `log_events_${sourceToken.replaceAll("-", "_")}`;
          phase = "Analytics Vector trigger setup";
          await analyticsSql.unsafe(`
          CREATE OR REPLACE FUNCTION _analytics."${functionName}"() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.event_message LIKE '%${EDGE_LOG_MARKER}%' THEN
              PERFORM pg_notify('${channel}', NEW.event_message);
            END IF;
            RETURN NEW;
          END;
          $fn$;
          DROP TRIGGER IF EXISTS "${triggerName}" ON _analytics."${physicalTable}";
          CREATE TRIGGER "${triggerName}"
          AFTER INSERT ON _analytics."${physicalTable}"
          FOR EACH ROW EXECUTE FUNCTION _analytics."${functionName}"();
        `);
          const notification = new Promise<string>((resolve) => {
            notificationResolve = resolve;
          });
          notificationSubscription = await analyticsSql.listen(channel, (payload) => {
            notificationResolve?.(payload);
          });
          phase = "Analytics Vector ingestion";
          const vectorFunctionResponse = await fetchFunctionWhenReady(
            `${stack.url}/functions/v1/native-services`,
          );
          expect(vectorFunctionResponse.status).toBe(200);
          expect(await vectorFunctionResponse.text()).toBe("native services ready");
          const observedNotification = await withTimeout(
            notification,
            "Analytics Vector ingestion",
          );
          expect(observedNotification).toContain(EDGE_LOG_MARKER);
          const analyticsQueryUrl = new URL(`${stack.url}/analytics/v1/api/query`);
          analyticsQueryUrl.search = new URLSearchParams({
            pg_sql: `SELECT event_message
FROM "postgres.logs"
WHERE "timestamp" > NOW() - INTERVAL '10' MINUTE
  AND event_message LIKE '%${EDGE_LOG_MARKER}%'
ORDER BY "timestamp" DESC
LIMIT 1`,
          }).toString();
          const analyticsQueryResponse = await fetch(analyticsQueryUrl, {
            headers: { "x-api-key": "native-services-analytics-key" },
          });
          if (analyticsQueryResponse.status !== 200) {
            const body = (await analyticsQueryResponse.text()).slice(0, 1_000);
            throw new Error(
              `Analytics Postgres query returned ${analyticsQueryResponse.status}: ${body}`,
            );
          }
          expect(JSON.stringify(await readJson(analyticsQueryResponse))).toContain(EDGE_LOG_MARKER);
        } finally {
          await notificationSubscription?.unlisten();
          if (physicalTable !== undefined) {
            await analyticsSql
              .unsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}" ON _analytics."${physicalTable}"; DROP FUNCTION IF EXISTS _analytics."${functionName}"();`,
              )
              .catch(() => {});
          }
          await analyticsSql.close();
        }

        phase = "Mailpit restart";
        const mailpitStream = stack.serviceLogs("mailpit")[Symbol.asyncIterator]();
        const observedLog = mailpitStream.next();
        await stack.restartService("mailpit");
        const logEvent = await withTimeout(observedLog, "Mailpit restart log");
        await mailpitStream.return?.();
        expect(logEvent.done).toBe(false);
        const logLine = logEvent.done ? "" : logEvent.value.line;
        expect(logLine.length).toBeGreaterThan(0);

        const finalStates = await stack.getStatus();
        expect(finalStates).toHaveLength(NATIVE_SERVICES.length);
        expect(finalStates.every((state) => state.status === "Healthy")).toBe(true);
        const vectorConfig = readFileSync(join(runtimeRoot, "vector", "vector.yaml"), "utf8");
        expect(vectorConfig).toContain("postgres.logs");
        expect(vectorConfig).toContain(`${runtimeRoot}/logs/vector.jsonl`);
        expect(vectorConfig).toContain("exclude:");
      } catch (error) {
        const diagnostics = journeyDiagnostics?.format() ?? "status/log diagnostics unavailable";
        throw new Error(
          `Native service journey failed during ${phase}: ${String(error)}\n${diagnostics}\n${realtimeClientDiagnostics?.format() ?? "realtime-client=[]"}`,
          { cause: error },
        );
      }
    },
  );
});
