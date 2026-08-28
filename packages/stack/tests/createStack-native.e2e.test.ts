// oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-fetch, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/process-env -- Native e2e tests await subprocess-backed stack operations and use filesystem/path fixtures.

import { createClient } from "@supabase/supabase-js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Predicate } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, prefetch, StackError, type StackHandle } from "@supabase/stack";
import { setupTestTable } from "./helpers/e2e.ts";

const activateWithoutDownload = async (
  stack: StackHandle,
  service: string,
  activate: () => Promise<unknown>,
): Promise<void> => {
  const iterator = stack.statusChanges()[Symbol.asyncIterator]();
  const first = iterator.next();
  const observed: string[] = [];
  try {
    await activate();
    let event = await first;
    while (!event.done) {
      if (event.value.name === service) {
        observed.push(event.value.status);
        if (event.value.status === "Healthy") break;
      }
      event = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
  expect(observed).toContain("Healthy");
  expect(observed).not.toContain("Downloading");
};

const drain = async (response: Response): Promise<void> => {
  await response.arrayBuffer();
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") !== "ESRCH";
  }
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

const stagingEntries = (root: string): ReadonlyArray<string> => {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.includes(".partial-") || entry.name.includes(".publication-lock")) {
      found.push(path);
    }
    if (entry.isDirectory()) found.push(...stagingEntries(path));
  }
  return found;
};

const markerValue = (path: string, key: string): unknown => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
};

describe("native PostgREST tracer bullet", () => {
  const jwtSecret = "native-e2e-jwt-secret-with-at-least-32-characters";
  let stack: StackHandle;
  let dataDir: string;
  let cacheRoot: string;
  let authCachePath: string;
  let postgresCachePath: string;
  let postgrestCachePath: string;
  let stackRoot: string;
  let runtimeRoot: string;
  let sentinelBin: string;
  let sentinelMarker: string;
  let originalPath: string | undefined;
  let stackDisposed = false;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-native-postgrest-e2e-"));
    cacheRoot = mkdtempSync(join(tmpdir(), "supabase-native-cache-"));
    stackRoot = mkdtempSync(join(tmpdir(), "supabase-native-stack-root-"));
    runtimeRoot = mkdtempSync(join(tmpdir(), "supabase-native-runtime-root-"));
    sentinelBin = mkdtempSync(join(tmpdir(), "supabase-native-runtime-sentinel-"));
    sentinelMarker = join(sentinelBin, "invoked");
    originalPath = process.env.PATH;
    for (const executable of ["docker", "podman"]) {
      const path = join(sentinelBin, executable);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$0" >> "${sentinelMarker}"\n`, "utf8");
      chmodSync(path, 0o755);
    }
    process.env.PATH = [sentinelBin, originalPath].filter((value) => value !== undefined).join(":");
    stack = await createStack({
      mode: "native",
      cacheRoot,
      stackRoot,
      runtimeRoot,
      functions: false,
      edgeRuntime: false,
      jwtSecret,
      postgres: { dataDir },
    });
    await stack.start();
    expect(existsSync(join(cacheRoot, "bin", "slim-services", "auth"))).toBe(false);
    expect(existsSync(join(cacheRoot, "bin", "slim-services", "postgrest"))).toBe(false);
    expect(existsSync(sentinelMarker)).toBe(false);

    const warmed = await prefetch({
      mode: "native",
      cacheRoot,
      services: ["auth", "postgrest"],
    });
    expect(warmed.postgres?.type).toBe("binary");
    expect(warmed.auth?.type).toBe("binary");
    expect(warmed.postgrest?.type).toBe("binary");
    expect(warmed.postgres?.type === "binary" && warmed.postgres.path.startsWith(cacheRoot)).toBe(
      true,
    );
    expect(warmed.auth?.type === "binary" && warmed.auth.path.startsWith(cacheRoot)).toBe(true);
    expect(warmed.postgrest?.type === "binary" && warmed.postgrest.path.startsWith(cacheRoot)).toBe(
      true,
    );
    if (warmed.auth?.type !== "binary") throw new Error("native Auth was not prefetched");
    if (warmed.postgres?.type !== "binary") throw new Error("native PostgreSQL was not prefetched");
    if (warmed.postgrest?.type !== "binary") throw new Error("native PostgREST was not prefetched");
    authCachePath = warmed.auth.path;
    postgresCachePath = warmed.postgres.path;
    postgrestCachePath = warmed.postgrest.path;
    expect(existsSync(sentinelMarker)).toBe(false);
    await setupTestTable(parseInt(new URL(stack.dbUrl).port));
  }, 180_000);

  afterAll(async () => {
    try {
      if (!stackDisposed) await stack?.dispose();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
      if (cacheRoot !== undefined) rmSync(cacheRoot, { recursive: true, force: true });
      if (stackRoot !== undefined) rmSync(stackRoot, { recursive: true, force: true });
      if (runtimeRoot !== undefined) rmSync(runtimeRoot, { recursive: true, force: true });
      if (sentinelBin !== undefined) rmSync(sentinelBin, { recursive: true, force: true });
    }
  }, 120_000);

  test("keeps lazy Auth and PostgREST dormant until their first requests", async () => {
    const statuses = await stack.getStatus();
    expect(statuses.find((state) => state.name === "postgres")?.status).toBe("Healthy");
    expect(statuses.find((state) => state.name === "auth")?.status).toBe("Dormant");
    expect(statuses.find((state) => state.name === "postgrest")?.status).toBe("Dormant");
  }, 30_000);

  test("retries Auth signup and password sessions after a corrected JIT preparation failure", async () => {
    const markerPath = join(authCachePath, ".complete");
    const marker = readFileSync(markerPath);
    const asset = markerValue(markerPath, "asset");
    if (typeof asset !== "string") throw new Error("native Auth marker has no asset name");
    const authParent = dirname(authCachePath);
    const movedParent = `${authParent}.fault`;
    const stalePartial = join(authParent, `.${asset}.partial-stale`);
    const staleLock = join(authParent, `.${asset}.publication-lock`);
    mkdirSync(stalePartial, { recursive: true });
    mkdirSync(staleLock, { recursive: true });
    utimesSync(stalePartial, new Date(0), new Date(0));
    utimesSync(staleLock, new Date(0), new Date(0));
    rmSync(movedParent, { recursive: true, force: true });
    renameSync(authParent, movedParent);
    writeFileSync(authParent, "native-auth-preparation-fault", "utf8");
    try {
      const failedRequest = await fetch(`${stack.url}/auth/v1/settings`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(failedRequest.status).toBe(503);
      await drain(failedRequest);

      let failure: unknown;
      try {
        await stack.startService("auth");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StackError);
      if (!(failure instanceof StackError))
        throw new Error("Auth preparation did not fail publicly");
      expect(failure.code).toBe("BUILD_ERROR");
      expect(Predicate.isTagged(failure.cause, "StackBuildError")).toBe(true);
      expect(await stack.getServiceStatus("postgres")).toMatchObject({ status: "Healthy" });
      expect(await stack.getServiceStatus("auth")).toMatchObject({ status: "Dormant" });
    } finally {
      rmSync(authParent, { force: true });
      renameSync(movedParent, authParent);
    }

    const authEmail = `native-${Date.now()}@example.com`;
    const authPassword = "native-password-123";
    const client = createClient(stack.url, stack.publishableKey);
    await activateWithoutDownload(stack, "auth", async () => {
      const signup = await client.auth.signUp({ email: authEmail, password: authPassword });
      expect(signup.error).toBeNull();
      expect(signup.data.user?.email).toBe(authEmail);
      expect(signup.data.session).not.toBeNull();
    });
    await client.auth.signOut();
    const signIn = await client.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });
    expect(signIn.error).toBeNull();
    expect(signIn.data.user?.email).toBe(authEmail);
    expect(signIn.data.session).not.toBeNull();
    expect(readFileSync(markerPath)).toEqual(marker);
    expect(existsSync(stalePartial)).toBe(false);
    expect(existsSync(staleLock)).toBe(false);
    expect(existsSync(sentinelMarker)).toBe(false);
  }, 30_000);

  test("starts eager native Auth and PostgREST before reporting readiness", async () => {
    const eagerDataDir = mkdtempSync(join(tmpdir(), "supabase-native-eager-data-"));
    const eager = await createStack({
      mode: "native",
      cacheRoot,
      functions: false,
      edgeRuntime: false,
      servicePolicies: { auth: "eager", postgrest: "eager" },
      jwtSecret,
      postgres: { dataDir: eagerDataDir },
    });
    try {
      await eager.start();
      const statuses = await eager.getStatus();
      expect(statuses.find((state) => state.name === "postgres")?.status).toBe("Healthy");
      expect(statuses.find((state) => state.name === "auth")?.status).toBe("Healthy");
      expect(statuses.find((state) => state.name === "postgrest")?.status).toBe("Healthy");
    } finally {
      await eager.dispose();
      rmSync(eagerDataDir, { recursive: true, force: true });
    }
    expect(existsSync(sentinelMarker)).toBe(false);
  }, 60_000);

  test("serves a CRUD request through the native PostgREST resource", async () => {
    const client = createClient(stack.url, stack.publishableKey);
    let inserted: { id: number; title: string; completed: boolean } | undefined;
    await activateWithoutDownload(stack, "postgrest", async () => {
      const result = await client
        .from("todos")
        .insert({ title: "native tracer bullet" })
        .select()
        .single();
      expect(result.error).toBeNull();
      expect(result.data).toEqual(expect.objectContaining({ title: "native tracer bullet" }));
      if (result.data === null) throw new Error("PostgREST insert returned no row");
      inserted = result.data;
    });
    if (inserted === undefined) throw new Error("PostgREST insert did not produce a row");

    const read = await client.from("todos").select().eq("id", inserted.id).single();
    expect(read.error).toBeNull();
    expect(read.data).toEqual(inserted);

    const updated = await client
      .from("todos")
      .update({ completed: !inserted.completed })
      .eq("id", inserted.id)
      .select()
      .single();
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual({ ...inserted, completed: !inserted.completed });

    const updatedRead = await client.from("todos").select().eq("id", inserted.id).single();
    expect(updatedRead.error).toBeNull();
    expect(updatedRead.data).toEqual(updated.data);

    const deleted = await client.from("todos").delete().eq("id", inserted.id).select().single();
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual(updated.data);

    const afterDelete = await client.from("todos").select().eq("id", inserted.id);
    expect(afterDelete.error).toBeNull();
    expect(afterDelete.data).toEqual([]);
  }, 30_000);

  test("exposes launch-scope PostgreSQL extensions through real SQL behavior", async () => {
    const sql = new Bun.SQL(stack.dbUrl);
    try {
      const rows = await sql.unsafe<
        {
          uuid: string;
          randomUuid: string;
          statements: number;
        }[]
      >(`
        SELECT
          extensions.uuid_generate_v4()::text AS uuid,
          extensions.gen_random_uuid()::text AS "randomUuid",
          (SELECT count(*)::int FROM extensions.pg_stat_statements(false)) AS statements;
      `);
      expect(rows[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]?.randomUuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]?.statements).toBeGreaterThan(0);
    } finally {
      await sql.close();
    }
  }, 30_000);

  test("preserves native data, endpoints, policies, and cache identity across restart", async () => {
    const markerPaths = [authCachePath, postgresCachePath, postgrestCachePath].map((path) =>
      join(path, ".complete"),
    );
    const identityKeys = ["runtime", "releaseSet", "service", "version", "target"];
    const identitiesBefore = markerPaths.map((path) =>
      identityKeys.map((key) => markerValue(path, key)),
    );
    for (const path of markerPaths) expect(markerValue(path, "runtime")).toBe("native");
    const before = {
      url: stack.url,
      dbUrl: stack.dbUrl,
      manifests: markerPaths.map((path) => readFileSync(path, "utf8")),
    };
    const sql = new Bun.SQL(stack.dbUrl);
    try {
      await sql.unsafe(
        `INSERT INTO public.todos (title, completed) VALUES ('native restart persistence', true)`,
      );
    } finally {
      await sql.close();
    }

    await stack.stop();
    await stack.start();

    expect(stack.url).toBe(before.url);
    expect(stack.dbUrl).toBe(before.dbUrl);
    expect(markerPaths.map((path) => readFileSync(path, "utf8"))).toEqual(before.manifests);
    expect(markerPaths.map((path) => identityKeys.map((key) => markerValue(path, key)))).toEqual(
      identitiesBefore,
    );
    const check = new Bun.SQL(stack.dbUrl);
    try {
      const rows = await check.unsafe<{ title: string }[]>(
        `SELECT title FROM public.todos WHERE title = 'native restart persistence'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("native restart persistence");
    } finally {
      await check.close();
    }
    const statuses = await stack.getStatus();
    expect(statuses.find((state) => state.name === "postgres")?.status).toBe("Healthy");
    expect(statuses.find((state) => state.name === "auth")?.status).toBe("Stopped");
    expect(statuses.find((state) => state.name === "postgrest")?.status).toBe("Stopped");

    await activateWithoutDownload(stack, "auth", async () => {
      const response = await fetch(`${stack.url}/auth/v1/settings`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(response.status).toBe(200);
      await drain(response);
    });
    await activateWithoutDownload(stack, "postgrest", async () => {
      const response = await fetch(`${stack.url}/rest/v1/todos?select=id&limit=1`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(response.status).toBe(200);
      await drain(response);
    });
    expect(await stack.getServiceStatus("auth")).toMatchObject({ status: "Healthy" });
    expect(await stack.getServiceStatus("postgrest")).toMatchObject({ status: "Healthy" });
    expect(existsSync(sentinelMarker)).toBe(false);
  }, 60_000);

  test("persists JWT settings in the native Postgres database", async () => {
    const sql = new Bun.SQL(stack.dbUrl);
    try {
      const rows = await sql.unsafe<{ jwt_secret: string; jwt_exp: string }[]>(`
        SELECT
          current_setting('app.settings.jwt_secret') AS jwt_secret,
          current_setting('app.settings.jwt_exp') AS jwt_exp;
      `);
      expect(rows[0]).toEqual({ jwt_secret: jwtSecret, jwt_exp: "3600" });
    } finally {
      await sql.close();
    }
  }, 30_000);

  test("repairs incomplete bundled initialization on restart", async () => {
    const adminUrl = new URL(stack.dbUrl);
    adminUrl.username = "supabase_admin";
    const sql = new Bun.SQL(adminUrl.toString());
    try {
      await sql.unsafe(`
        DELETE FROM supabase_migrations.cli_init WHERE phase = 'complete';
        ALTER ROLE authenticator RESET session_preload_libraries;
      `);
    } finally {
      await sql.close();
    }

    await stack.stop();
    await stack.start();

    const check = new Bun.SQL(adminUrl.toString());
    try {
      const rows = await check.unsafe<{ configured: boolean }[]>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = 'authenticator'
            AND EXISTS (
              SELECT 1
              FROM unnest(coalesce(rolconfig, ARRAY[]::text[])) setting
              WHERE setting LIKE 'session_preload_libraries=supautils%'
            )
        ) AS configured;
      `);
      expect(rows[0]?.configured).toBe(true);
    } finally {
      await check.close();
    }
  }, 30_000);

  test("disposes exact native resources without deleting completed cache or data", async () => {
    await activateWithoutDownload(stack, "auth", async () => {
      const response = await fetch(`${stack.url}/auth/v1/settings`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(response.status).toBe(200);
      await drain(response);
    });
    await activateWithoutDownload(stack, "postgrest", async () => {
      const response = await fetch(`${stack.url}/rest/v1/todos?select=id&limit=1`, {
        headers: { apikey: stack.publishableKey },
      });
      expect(response.status).toBe(200);
      await drain(response);
    });

    const healthyStates = await stack.getStatus();
    const ownedPids = ["postgres", "auth", "postgrest"].map((name) => {
      const state = healthyStates.find((entry) => entry.name === name);
      expect(state?.status).toBe("Healthy");
      if (state?.pid === null || state?.pid === undefined) {
        throw new Error(`${name} did not publish a process id while healthy`);
      }
      return state.pid;
    });
    const apiPort = Number(new URL(stack.url).port);
    const dbPort = Number(new URL(stack.dbUrl).port);
    expect(Number.isInteger(apiPort)).toBe(true);
    expect(Number.isInteger(dbPort)).toBe(true);

    await stack.dispose();
    stackDisposed = true;
    expect(ownedPids.every((pid) => !isProcessAlive(pid))).toBe(true);
    await bindAndClose(apiPort);
    await bindAndClose(dbPort);
    expect(stagingEntries(cacheRoot)).toEqual([]);
    expect(
      [authCachePath, postgresCachePath, postgrestCachePath].every((path) =>
        existsSync(join(path, ".complete")),
      ),
    ).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(stackRoot)).toBe(true);
    expect(existsSync(runtimeRoot)).toBe(true);
    expect(existsSync(sentinelMarker)).toBe(false);

    rmSync(stackRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
    expect(existsSync(stackRoot)).toBe(false);
    expect(existsSync(runtimeRoot)).toBe(false);
  }, 60_000);
});
