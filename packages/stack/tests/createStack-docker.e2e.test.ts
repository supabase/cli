import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { activationTimeoutSecondsForService } from "../src/ServiceActivation.ts";
import { createStack, type StackHandle } from "../src/node.ts";
import { dependencyTimeoutSecondsForServices } from "../src/services/health-budgets.ts";
import { DEFAULT_VERSIONS } from "../src/versions.ts";
import { setupTestTable } from "./helpers/e2e.ts";

const STACK_DOCKER_E2E_TEST_TIMEOUT_MS = 180_000;
const STACK_DOCKER_E2E_SETUP_OVERHEAD_MS = 90_000;
const STACK_DOCKER_E2E_SETUP_TIMEOUT_MS =
  dependencyTimeoutSecondsForServices(["postgres"]) * 1000 + STACK_DOCKER_E2E_SETUP_OVERHEAD_MS;
const ANALYTICS_COLD_START_TEST_TIMEOUT_MS = activationTimeoutSecondsForService("analytics") * 1000;

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
      analytics: {},
    });

    try {
      await stack.start();
    } catch (startError) {
      await stack.dispose().catch(() => {});
      throw startError;
    }

    const dbPort = parseInt(new URL(stack.dbUrl).port);
    try {
      await setupTestTable(dbPort);
    } catch (error) {
      const status = await stack.getStatus();
      const logs = await stack.logHistory("postgres");
      throw new Error(
        `setupTestTable failed: ${String(error)}\nstatus=${JSON.stringify(status)}\nlogs=${JSON.stringify(logs)}`,
      );
    }

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
      await Promise.all([stack.startService("postgrest"), stack.startService("auth")]);

      const runningImages = execSync("docker ps --format '{{.Image}}'").toString();
      expect(runningImages).toContain(
        `ghcr.io/supabase/cli/postgrest:${DEFAULT_VERSIONS.postgrest}`,
      );
      expect(runningImages).toContain(`ghcr.io/supabase/cli/postgres:${DEFAULT_VERSIONS.postgres}`);
      expect(runningImages).toContain(`ghcr.io/supabase/cli/auth:${DEFAULT_VERSIONS.auth}`);

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
    "runs the edge runtime in Docker and serves the functions placeholder through the local gateway",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      const functionsRes = await fetch(`${stack.url}/functions/v1/test`);
      await stack.serviceReady("edge-runtime");
      const runningImages = execSync("docker ps --format '{{.Image}}'").toString();
      const states = await stack.getStatus();

      expect(runningImages).toContain(
        `ghcr.io/supabase/cli/edge-runtime:${DEFAULT_VERSIONS["edge-runtime"]}`,
      );
      expect(states).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "edge-runtime", status: "Healthy" }),
        ]),
      );
      expect(functionsRes.status).toBe(501);
      expect(await functionsRes.json()).toEqual({
        code: "FUNCTIONS_NOT_CONFIGURED",
        message: "Edge Functions are not configured for this local stack yet.",
      });
    },
  );

  test(
    "cold-starts analytics through lazy service activation",
    { timeout: ANALYTICS_COLD_START_TEST_TIMEOUT_MS },
    async () => {
      expect(await stack.getServiceStatus("analytics")).toEqual(
        expect.objectContaining({ status: "Dormant" }),
      );

      await stack.startService("analytics");

      const [runningImages, states] = await Promise.all([
        Promise.resolve(execSync("docker ps --format '{{.Image}}'").toString()),
        stack.getStatus(),
      ]);

      expect(runningImages).toContain(
        `ghcr.io/supabase/cli/analytics:${DEFAULT_VERSIONS.analytics}`,
      );
      expect(states).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "analytics", status: "Healthy" })]),
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

  test(
    "restarts the Studio graph with its Pgmeta dependency",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      const graphDataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-docker-graph-"));
      let graphStack: StackHandle | undefined;
      try {
        graphStack = await createStack({
          mode: "docker",
          postgres: { dataDir: graphDataDir },
          pgmeta: {},
          studio: {},
        });
        await graphStack.start();
        expect(await graphStack.getServiceStatus("pgmeta")).toEqual(
          expect.objectContaining({ status: "Healthy" }),
        );
        expect(await graphStack.getServiceStatus("studio")).toEqual(
          expect.objectContaining({ status: "Healthy" }),
        );

        await graphStack.stop();
        await graphStack.start();

        expect(await graphStack.getServiceStatus("pgmeta")).toEqual(
          expect.objectContaining({ status: "Healthy" }),
        );
        expect(await graphStack.getServiceStatus("studio")).toEqual(
          expect.objectContaining({ status: "Healthy" }),
        );
      } finally {
        await graphStack?.dispose();
        rmSync(graphDataDir, { recursive: true, force: true });
      }
    },
  );
});
