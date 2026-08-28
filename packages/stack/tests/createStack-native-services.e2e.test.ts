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
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createStack,
  prefetch,
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

const bindAndClose = async (port: number): Promise<void> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
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

const withTimeout = async <A>(promise: Promise<A>, timeoutMs = 60_000): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  let vectorAdminPort: number | undefined;
  let analyticsDirectPort: number | undefined;

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
        realtime: "eager",
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

    try {
      await stack.start();
    } catch (error) {
      await stack.dispose().catch(() => {});
      throw error;
    }
    supabase = createClient(stack.url, stack.publishableKey);
    await setupTestTable(Number(new URL(stack.dbUrl).port));
    const vectorConfig = readFileSync(join(runtimeRoot, "vector", "vector.yaml"), "utf8");
    const vectorPortMatch = /address:\s*"127\.0\.0\.1:(\d+)"/.exec(vectorConfig);
    if (vectorPortMatch === null) throw new Error("native Vector admin port is missing");
    vectorAdminPort = Number(vectorPortMatch[1]);
    const analyticsPortMatch = /uri:\s*"http:\/\/127\.0\.0\.1:(\d+)\/api\/logs/.exec(vectorConfig);
    if (analyticsPortMatch === null)
      throw new Error("native Analytics port is missing from Vector config");
    analyticsDirectPort = Number(analyticsPortMatch[1]);
  }, 1_200_000);

  afterAll(async () => {
    try {
      const ownedPorts = new Set<number>();
      if (stack !== undefined) {
        for (const endpoint of Object.values(stack.serviceEndpoints)) {
          ownedPorts.add(endpointPort(endpoint));
        }
        ownedPorts.add(endpointPort(stack.url));
        ownedPorts.add(endpointPort(stack.dbUrl));
      }
      if (vectorAdminPort !== undefined) ownedPorts.add(vectorAdminPort);
      if (analyticsDirectPort !== undefined) ownedPorts.add(analyticsDirectPort);
      if (stack !== undefined) {
        const states = await stack.getStatus().catch(() => []);
        ownedPids = states.flatMap((state) => (state.pid === null ? [] : [state.pid]));
        await stack.dispose();
        for (const pid of ownedPids) expect(isProcessAlive(pid)).toBe(false);
      }
      expect(existsSync(sentinelMarker)).toBe(false);
      expect(stagingEntries(cacheRoot)).toEqual([]);
      expect(stagingEntries(stackRoot)).toEqual([]);
      expect(stagingEntries(runtimeRoot)).toEqual([]);
      for (const port of ownedPorts) {
        await bindAndClose(port);
      }
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
      const initialStates = await stack.getStatus();
      expect(initialStates.map((state) => state.name).toSorted()).toEqual(
        [...NATIVE_SERVICES].toSorted(),
      );
      expect(
        initialStates.filter((state) => state.status === "Healthy").map((state) => state.name),
      ).toEqual(
        expect.arrayContaining([
          "postgres",
          "realtime",
          "mailpit",
          "pgmeta",
          "studio",
          "analytics",
          "vector",
          "pooler",
        ]),
      );
      expect(existsSync(sentinelMarker)).toBe(false);

      const authSettings = await fetch(`${stack.url}/auth/v1/settings`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(authSettings.status).toBe(200);
      await authSettings.arrayBuffer();

      const functionResponse = await fetchFunctionWhenReady(
        `${stack.url}/functions/v1/native-services`,
      );
      expect(functionResponse.status).toBe(200);
      expect(await functionResponse.text()).toBe("native services ready");

      const postgrestTable = await supabase.from("todos").select("id").limit(1);
      expect(postgrestTable.error).toBeNull();

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

      const realtime = createClient(stack.url, stack.publishableKey);
      let realtimeChannel: ReturnType<typeof realtime.channel> | undefined;
      const realtimeChange = new Promise<unknown>((resolve, reject) => {
        realtimeChannel = realtime
          .channel("native-services-todos")
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "todos" },
            (payload) => resolve(payload),
          )
          .subscribe((status) => {
            if (status !== "SUBSCRIBED") {
              if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                reject(new Error(`Realtime subscription status: ${status}`));
              }
              return;
            }
            const insert = new Bun.SQL(stack.dbUrl);
            void insert
              .unsafe(
                `INSERT INTO public.todos (title, completed) VALUES ('native-realtime', false)`,
              )
              .then(() => insert.close())
              .catch(async (error: unknown) => {
                await insert.close();
                reject(error instanceof Error ? error : new Error(String(error)));
              });
          });
      });
      try {
        const change = await withTimeout(realtimeChange);
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

      const bucket = `native-services-${Date.now()}`;
      const createdBucket = await supabase.storage.createBucket(bucket, { public: true });
      expect(createdBucket.error).toBeNull();
      const uploaded = await supabase.storage
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

      const pooled = new Bun.SQL(requiredEndpoint(stack.serviceEndpoints, "pooler"));
      try {
        const rows = await pooled.unsafe<{ answer: number }[]>("SELECT 40 + 2 AS answer");
        expect(rows[0]?.answer).toBe(42);
      } finally {
        await pooled.close();
      }

      if (analyticsDirectPort === undefined)
        throw new Error("native Analytics port is unavailable");
      const sourcesResponse = await fetch(`http://127.0.0.1:${analyticsDirectPort}/api/sources`, {
        headers: { "x-api-key": "native-services-analytics-key" },
      });
      expect(sourcesResponse.status).toBe(200);
      const sourcesBody = await readJson(sourcesResponse);
      const sources = Array.isArray(sourcesBody)
        ? sourcesBody
        : typeof sourcesBody === "object" && sourcesBody !== null
          ? Reflect.get(sourcesBody, "sources")
          : undefined;
      if (!Array.isArray(sources)) throw new Error("Analytics source list is not an array");
      const postgresLogs = sources.find(
        (source: unknown) =>
          typeof source === "object" &&
          source !== null &&
          Reflect.get(source, "name") === "postgres.logs",
      );
      if (typeof postgresLogs !== "object" || postgresLogs === null) {
        throw new Error("Analytics postgres.logs source is missing");
      }
      const sourceToken = Reflect.get(postgresLogs, "token");
      if (typeof sourceToken !== "string" || !/^[0-9a-f-]+$/i.test(sourceToken)) {
        throw new Error("Analytics postgres.logs source token is invalid");
      }
      const physicalTable = `log_events_${sourceToken.replaceAll("-", "_")}`;
      const triggerId = String(Date.now());
      const triggerName = `native_vector_trigger_${triggerId}`;
      const functionName = `native_vector_notify_${triggerId}`;
      const channel = `native_vector_${triggerId}`;
      const analyticsDbUrl = new URL(stack.dbUrl);
      analyticsDbUrl.pathname = "/_supabase";
      const analyticsSql = new Bun.SQL(analyticsDbUrl.toString());
      let notificationSubscription: Awaited<ReturnType<typeof analyticsSql.listen>> | undefined;
      let notificationResolve: ((payload: string) => void) | undefined;
      try {
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
        const vectorFunctionResponse = await fetchFunctionWhenReady(
          `${stack.url}/functions/v1/native-services`,
        );
        expect(vectorFunctionResponse.status).toBe(200);
        expect(await vectorFunctionResponse.text()).toBe("native services ready");
        const observedNotification = await withTimeout(notification);
        expect(observedNotification).toContain(EDGE_LOG_MARKER);
        const recentResponse = await fetch(
          `http://127.0.0.1:${analyticsDirectPort}/api/sources/${sourceToken}/recent`,
          { headers: { "x-api-key": "native-services-analytics-key" } },
        );
        expect(recentResponse.status).toBe(200);
        expect(JSON.stringify(await readJson(recentResponse))).toContain(EDGE_LOG_MARKER);
      } finally {
        await notificationSubscription?.unlisten();
        await analyticsSql
          .unsafe(
            `DROP TRIGGER IF EXISTS "${triggerName}" ON _analytics."${physicalTable}"; DROP FUNCTION IF EXISTS _analytics."${functionName}"();`,
          )
          .catch(() => {});
        await analyticsSql.close();
      }

      const mailpitStream = stack.serviceLogs("mailpit")[Symbol.asyncIterator]();
      const observedLog = mailpitStream.next();
      await stack.restartService("mailpit");
      const logEvent = await withTimeout(observedLog);
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
    },
  );
});
