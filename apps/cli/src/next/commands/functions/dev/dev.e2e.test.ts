import { describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
  spawnSupabase,
} from "../../../../../tests/helpers/cli.ts";

const FUNCTIONS_DEV_STEP_TIMEOUT_MS = 120_000;
const FUNCTIONS_DEV_TEST_TIMEOUT_MS = 300_000;

async function waitForFunctionResponse(
  url: string,
  init: RequestInit,
  assertResponse: (response: Response, body: string) => void,
) {
  const deadline = Date.now() + FUNCTIONS_DEV_STEP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      const body = await response.text();
      try {
        assertResponse(response, body);
        return;
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for function response: ${String(lastError)}`);
}

describe("supabase functions dev", () => {
  test(
    "serves a function created while running and applies live config and source changes",
    { timeout: FUNCTIONS_DEV_TEST_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-functions-dev-e2e-");
      const functionPath = join(project.dir, "supabase", "functions", "hello-world", "index.ts");
      const functionUrl = `http://127.0.0.1:${project.ports.apiPort}/functions/v1/hello-world`;
      let devProc: ReturnType<typeof spawnSupabase> | undefined;

      try {
        devProc = spawnSupabase(["functions", "dev"], {
          cwd: project.dir,
          home: home.dir,
          cleanupProcessGroupOnClose: false,
          exitTimeoutMs: FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        });

        await devProc.waitForOutput(
          /Edge Functions dev server is running\./,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        );

        const newResult = await runSupabase(["functions", "new", "hello-world"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        });
        expect(newResult.exitCode).toBe(0);

        await devProc.waitForOutput(
          /Function files changed\. Restarting edge-runtime\./,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        );

        await waitForFunctionResponse(functionUrl, {}, (response, body) => {
          expect(response.status).toBe(401);
          expect(body).toContain("Missing authorization header");
        });

        await writeFile(
          join(project.dir, "supabase", "config.toml"),
          `project_id = "functions-dev-e2e"

[functions.hello-world]
verify_jwt = false
`,
        );

        await devProc.waitForOutput(
          /Edge runtime config changed\. Restarting edge-runtime\./,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        );

        await waitForFunctionResponse(
          functionUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Functions Dev" }),
          },
          (response, body) => {
            expect(response.status).toBe(200);
            expect(JSON.parse(body)).toEqual({ message: "Hello Functions Dev!" });
          },
        );

        await writeFile(
          functionPath,
          `Deno.serve(() => {
  return new Response(JSON.stringify({ message: "Updated from source edit" }), {
    headers: { "content-type": "application/json" },
  });
});
`,
        );

        await waitForFunctionResponse(
          functionUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Functions Dev" }),
          },
          (response, body) => {
            expect(response.status).toBe(200);
            expect(JSON.parse(body)).toEqual({ message: "Updated from source edit" });
          },
        );
      } finally {
        devProc?.kill("SIGTERM");
        await devProc?.waitForExit().catch(() => {});
      }
    },
  );
});
