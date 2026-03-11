import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { setupTestTable } from "./helpers/e2e.ts";

describe("createStack e2e", () => {
  let stack: StackHandle;
  let dataDir: string;
  let supabase: SupabaseClient;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supa-e2e-"));

    stack = await createStack({
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
      postgres: { dataDir },
    });

    try {
      await stack.start();
    } catch (startError) {
      await stack.dispose().catch(() => {});
      throw startError;
    }

    const dbPort = parseInt(new URL(stack.dbUrl).port);
    await setupTestTable(dbPort);

    supabase = createClient(stack.url, stack.publishableKey);
  }, 45_000);

  afterAll(async () => {
    await stack?.dispose();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  // --- Health ---

  describe("health", () => {
    test("proxy health returns 200", async () => {
      const res = await fetch(`${stack.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });

    test("auth health returns 200", async () => {
      const res = await fetch(`${stack.url}/auth/v1/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("description");
    });
  });

  // --- Auth ---

  describe("auth", () => {
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = "test-password-123";

    test("sign up creates user", async () => {
      const { data, error } = await supabase.auth.signUp({
        email: testEmail,
        password: testPassword,
      });

      expect(error).toBeNull();
      expect(data.user).toBeDefined();
      expect(data.user?.email).toBe(testEmail);
      expect(data.session).toBeDefined();
    });

    test("sign in returns session with valid JWT", async () => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: testEmail,
        password: testPassword,
      });

      expect(error).toBeNull();
      expect(data.session).toBeDefined();
      expect(data.session?.access_token).toBeTruthy();
      expect(data.user?.email).toBe(testEmail);
    });

    test("get current user returns user info", async () => {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      expect(error).toBeNull();
      expect(user).toBeDefined();
      expect(user?.email).toBe(testEmail);
    });

    test("sign out succeeds", async () => {
      const { error } = await supabase.auth.signOut();
      expect(error).toBeNull();
    });
  });

  // --- PostgREST CRUD ---

  describe("PostgREST CRUD", () => {
    test("query todos returns seeded data", async () => {
      const { data, error } = await supabase.from("todos").select("*").order("id");

      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      expect(data![0].title).toBe("Learn Supabase");
      expect(data![1].title).toBe("Build an app");
    });

    test("filter incomplete todos", async () => {
      const { data, error } = await supabase
        .from("todos")
        .select("id, title")
        .eq("completed", false)
        .order("id");

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0]?.title).toBe("Build an app");
    });

    test("insert new todo", async () => {
      const { data, error } = await supabase
        .from("todos")
        .insert({ title: "E2E test todo" })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data!.title).toBe("E2E test todo");
      expect(data!.completed).toBe(false);
    });

    test("update todo", async () => {
      const { data, error } = await supabase
        .from("todos")
        .update({ completed: true })
        .eq("title", "E2E test todo")
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data!.completed).toBe(true);
    });

    test("delete todo", async () => {
      const { error: deleteError } = await supabase
        .from("todos")
        .delete()
        .eq("title", "E2E test todo");

      expect(deleteError).toBeNull();

      // Verify deletion
      const { data } = await supabase.from("todos").select("*").eq("title", "E2E test todo");

      expect(data).toHaveLength(0);
    });
  });
});
