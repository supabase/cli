import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { setupTestTable } from "./helpers/e2e.ts";

const STACK_DOCKER_E2E_TEST_TIMEOUT_MS = 5_000;
const STACK_DOCKER_E2E_SETUP_TIMEOUT_MS = 90_000;

function hasDockerDaemon(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerDescribe = hasDockerDaemon() ? describe : describe.skip;

dockerDescribe("createStack e2e (docker mode)", () => {
  let stack: StackHandle;
  let dataDir: string;
  let apiPort: string;
  let supabase: SupabaseClient;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-docker-"));

    stack = await createStack({
      mode: "docker",
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

    apiPort = new URL(stack.url).port;
    supabase = createClient(stack.url, stack.publishableKey);
  }, STACK_DOCKER_E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.dispose();

    // Verify all Docker containers are cleaned up after dispose
    const remaining = execSync(`docker ps -q --filter name=supabase-.*-${apiPort}`)
      .toString()
      .trim();
    expect(remaining).toBe("");

    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  test(
    "runs the core services in Docker containers and serves health endpoints",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      const runningImages = execSync("docker ps --format '{{.Image}}'").toString();
      expect(runningImages).toContain("supabase/postgrest");
      expect(runningImages).toContain("supabase/postgres");
      expect(runningImages).toContain("supabase/gotrue");

      const [proxyRes, authRes] = await Promise.all([
        fetch(`${stack.url}/health`),
        fetch(`${stack.url}/auth/v1/health`),
      ]);
      expect(proxyRes.status).toBe(200);
      expect(await proxyRes.text()).toBe("OK");
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toEqual(
        expect.objectContaining({ description: expect.any(String) }),
      );
    },
  );

  test(
    "supports the docker auth signup and session golden path",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      const testEmail = `test-${Date.now()}@example.com`;
      const testPassword = "test-password-123";

      const signUp = await supabase.auth.signUp({
        email: testEmail,
        password: testPassword,
      });
      expect(signUp.error).toBeNull();
      expect(signUp.data.user?.email).toBe(testEmail);
      expect(signUp.data.session).toBeDefined();

      const signIn = await supabase.auth.signInWithPassword({
        email: testEmail,
        password: testPassword,
      });
      expect(signIn.error).toBeNull();
      expect(signIn.data.user?.email).toBe(testEmail);
      expect(signIn.data.session?.access_token).toBeTruthy();

      const currentUser = await supabase.auth.getUser();
      expect(currentUser.error).toBeNull();
      expect(currentUser.data.user?.email).toBe(testEmail);
    },
  );

  test(
    "supports a full docker PostgREST CRUD golden path",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      const seeded = await supabase.from("todos").select("*").order("id");
      expect(seeded.error).toBeNull();
      expect(seeded.data).toHaveLength(2);

      const inserted = await supabase
        .from("todos")
        .insert({ title: "E2E test todo" })
        .select()
        .single();
      expect(inserted.error).toBeNull();
      expect(inserted.data?.title).toBe("E2E test todo");

      const updated = await supabase
        .from("todos")
        .update({ completed: true })
        .eq("title", "E2E test todo")
        .select()
        .single();
      expect(updated.error).toBeNull();
      expect(updated.data?.completed).toBe(true);

      const deleted = await supabase.from("todos").delete().eq("title", "E2E test todo");
      expect(deleted.error).toBeNull();

      const remaining = await supabase.from("todos").select("*").eq("title", "E2E test todo");
      expect(remaining.data).toHaveLength(0);
    },
  );
});
