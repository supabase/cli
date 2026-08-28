import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { activationTimeoutSecondsForService } from "../src/ServiceActivation.ts";
import { createStack, type ResolvedFunctionsBundle, type StackHandle } from "../src/node.ts";
import { fetchFunctionWhenReady, setupTestTable } from "./helpers/e2e.ts";

const AUTH_COLD_START_TEST_TIMEOUT_MS = activationTimeoutSecondsForService("auth") * 1000;

describe("createStack e2e", () => {
  let stack: StackHandle;
  let dataDir: string;
  let projectDir: string;
  let supabase: SupabaseClient;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-"));
    projectDir = mkdtempSync(join(tmpdir(), "supabase-e2e-project-"));
    writeFunction(projectDir, "hello", "hello");
    writeSharedFunction(projectDir);

    stack = await createStack({
      projectDir,
      functions: functionsBundle(projectDir, ["hello", "shared-alpha", "shared-beta"]),
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
      rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  test(
    "serves detected Edge Functions through the local gateway",
    { timeout: 30_000 },
    async () => {
      // "Healthy" only means the edge-runtime control plane answered its health
      // probe; the first request to a function still lazily cold-boots a user
      // worker, so wait for the function to actually become servable.
      const functionsRes = await fetchFunctionWhenReady(`${stack.url}/functions/v1/hello`);
      const states = await stack.getStatus();

      expect(states).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "edge-runtime", status: "Healthy" }),
        ]),
      );
      expect(functionsRes.status).toBe(200);
      expect(await functionsRes.text()).toBe("hello");
    },
  );

  test(
    "keeps worker env isolated for functions sharing a source directory",
    { timeout: 30_000 },
    async () => {
      const [alpha, beta] = await Promise.all([
        fetchFunctionWhenReady(`${stack.url}/functions/v1/shared-alpha`),
        fetchFunctionWhenReady(`${stack.url}/functions/v1/shared-beta`),
      ]);
      const reusedAlpha = await fetchFunctionWhenReady(`${stack.url}/functions/v1/shared-alpha`);

      expect(alpha.status).toBe(200);
      expect(await alpha.text()).toBe("shared-alpha:shared-import-ok");
      expect(beta.status).toBe(200);
      expect(await beta.text()).toBe("shared-beta:shared-import-ok");
      expect(reusedAlpha.status).toBe(200);
      expect(await reusedAlpha.text()).toBe("shared-alpha:shared-import-ok");
    },
  );

  test("reloadFunctions picks up newly added Edge Functions", { timeout: 30_000 }, async () => {
    writeFunction(projectDir, "later", "later");
    await stack.reloadFunctions({ functions: functionsBundle(projectDir, ["hello", "later"]) });

    const res = await fetchFunctionWhenReady(`${stack.url}/functions/v1/later`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("later");
  });

  test(
    "supports the auth signup and session golden path",
    { timeout: AUTH_COLD_START_TEST_TIMEOUT_MS },
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

  test("supports a full PostgREST CRUD golden path", { timeout: 30_000 }, async () => {
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
  });
});

function codeSafeJson(value: string) {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function writeFunction(projectDir: string, slug: string, body: string) {
  const dir = join(projectDir, "supabase", "functions", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `Deno.serve(() => new Response(${codeSafeJson(body)}));\n`);
}

function writeSharedFunction(projectDir: string) {
  const functionsDir = join(projectDir, "supabase", "functions");
  const sharedDir = join(functionsDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(join(functionsDir, "_shared"), { recursive: true });
  writeFileSync(
    join(functionsDir, "_shared", "value.ts"),
    'export const sharedValue = "shared-import-ok";\n',
  );
  writeFileSync(
    join(sharedDir, "index.ts"),
    `import { sharedValue } from "../_shared/value.ts";

Deno.serve(() => new Response(
  (Deno.env.get("SUPABASE_FUNCTION_SLUG") ?? "") + ":" + sharedValue,
));
`,
  );
}

function functionsBundle(
  projectDir: string,
  names: ReadonlyArray<string>,
): ResolvedFunctionsBundle {
  return {
    env: {},
    functions: names.map((name) => ({
      name,
      verifyJWT: false,
      entrypointPath: join(
        projectDir,
        "supabase",
        "functions",
        name.startsWith("shared-") ? "shared" : name,
        "index.ts",
      ),
      importMapPath: null,
      staticFiles: [],
      env: {},
    })),
  };
}
