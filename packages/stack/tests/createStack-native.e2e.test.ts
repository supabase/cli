// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { defaultCacheRoot } from "../src/paths.ts";
import { setupTestTable } from "./helpers/e2e.ts";

describe("native PostgREST tracer bullet", () => {
  const jwtSecret = "native-e2e-jwt-secret-with-at-least-32-characters";
  let stack: StackHandle;
  let dataDir: string;
  let cacheParent: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-native-postgrest-e2e-"));
    cacheParent = mkdtempSync(join(tmpdir(), "supabase-native-cache-parent-"));
    const cacheRoot = join(cacheParent, "cache root with spaces");
    symlinkSync(defaultCacheRoot(), cacheRoot, "dir");
    stack = await createStack({
      mode: "native",
      cacheRoot,
      functions: false,
      edgeRuntime: false,
      auth: false,
      jwtSecret,
      postgres: { dataDir },
    });
    await stack.start();
    await setupTestTable(parseInt(new URL(stack.dbUrl).port));
  }, 45_000);

  afterAll(async () => {
    await stack?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cacheParent, { recursive: true, force: true });
  }, 30_000);

  test("serves a CRUD request through the native PostgREST resource", async () => {
    const client = createClient(stack.url, stack.publishableKey);
    const inserted = await client
      .from("todos")
      .insert({ title: "native tracer bullet" })
      .select()
      .single();

    expect(inserted.error).toBeNull();
    expect(inserted.data).toEqual(expect.objectContaining({ title: "native tracer bullet" }));

    const deleted = await client.from("todos").delete().eq("title", "native tracer bullet");
    expect(deleted.error).toBeNull();
  }, 30_000);

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
});
