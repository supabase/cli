import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  spawnSupabase,
} from "../../../../../tests/helpers/cli.ts";
import { cleanupRegisteredStackProjects } from "../../../../../tests/helpers/stack-e2e-cleanup.ts";

const FUNCTIONS_DEV_STARTUP_TIMEOUT_MS = 60_000;
const FUNCTIONS_DEV_STEP_TIMEOUT_MS = 30_000;
const FUNCTIONS_DEV_TEST_TIMEOUT_MS = 90_000;
const FUNCTION_RESPONSE_ATTEMPT_TIMEOUT_MS = 5_000;
const FUNCTION_RESPONSE_RETRY_BACKOFF_MS = 250;
const FUNCTION_FILES_RESTART_PATTERN = /Function files changed\. Restarting edge-runtime\./;

type SpawnedSupabase = ReturnType<typeof spawnSupabase>;

async function assertFunctionResponse(
  url: string,
  init: RequestInit,
  assertResponse: (response: Response, body: string) => void,
  timeoutMs = FUNCTIONS_DEV_STEP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown = new Error("No response received");

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.min(remainingMs, FUNCTION_RESPONSE_ATTEMPT_TIMEOUT_MS)),
      });
      const body = await response.text();
      assertResponse(response, body);
      return;
    } catch (error) {
      lastFailure = error;
      // Bound request frequency while the worker catches up after a reload;
      // the wall-clock deadline, rather than an attempt count, remains the guard.
      const retryDelayMs = Math.min(
        FUNCTION_RESPONSE_RETRY_BACKOFF_MS,
        Math.max(0, deadline - Date.now()),
      );
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw new Error(
    `Function request ${url} did not reach the expected response within ${timeoutMs}ms. ` +
      `Last failure: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
  );
}

describe("supabase functions dev (e2e)", () => {
  afterEach(cleanupRegisteredStackProjects);

  test(
    "serves a function created while running and applies config and source changes",
    { timeout: FUNCTIONS_DEV_TEST_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      // The next functions runtime owns managed port allocation. This project
      // intentionally contains no released-port reservations from the test.
      const project = await makeTempCliProject("supabase-functions-dev-e2e-");
      await mkdir(join(project.dir, "supabase"), { recursive: true });
      await writeFile(
        join(project.dir, "supabase", "config.toml"),
        'project_id = "functions-dev-e2e"\n',
      );
      const functionPath = join(project.dir, "supabase", "functions", "hello-world", "index.ts");
      let devProc: SpawnedSupabase | undefined;

      try {
        devProc = spawnSupabase(["functions", "dev"], {
          cwd: project.dir,
          home: home.dir,
          cleanupProcessGroupOnClose: false,
          exitTimeoutMs: FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        });

        await devProc.waitForOutput(
          /Edge Functions dev server is running\./,
          FUNCTIONS_DEV_STARTUP_TIMEOUT_MS,
        );
        const functionUrlMatch = `${devProc.stdout()}\n${devProc.stderr()}`.match(
          /Functions URL:\s+(https?:\/\/[^\s/]+\/functions\/v1)/,
        );
        if (functionUrlMatch?.[1] === undefined) {
          throw new Error(
            `Functions dev output did not include a URL.\nstdout:\n${devProc.stdout()}\nstderr:\n${devProc.stderr()}`,
          );
        }
        const functionUrl = `${functionUrlMatch[1]}/hello-world`;

        const functionOffset = devProc.stdout().length;
        const functionRestart = devProc.waitForOutput(
          FUNCTION_FILES_RESTART_PATTERN,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
          functionOffset,
        );
        const newResult = await runSupabase(["functions", "new", "hello-world"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: FUNCTIONS_DEV_STEP_TIMEOUT_MS,
        });
        expect(newResult.exitCode).toBe(0);
        await functionRestart;

        await assertFunctionResponse(functionUrl, {}, (response, body) => {
          expect(response.status).toBe(401);
          expect(body).toContain("Missing authorization header");
        });

        const configOffset = devProc.stdout().length;
        const configRestart = devProc.waitForOutput(
          FUNCTION_FILES_RESTART_PATTERN,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
          configOffset,
        );
        await writeFile(
          join(project.dir, "supabase", "config.toml"),
          `project_id = "functions-dev-e2e"

[functions.hello-world]
verify_jwt = false
`,
        );
        await configRestart;

        await assertFunctionResponse(
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

        const sourceOffset = devProc.stdout().length;
        const sourceRestart = devProc.waitForOutput(
          FUNCTION_FILES_RESTART_PATTERN,
          FUNCTIONS_DEV_STEP_TIMEOUT_MS,
          sourceOffset,
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
        await sourceRestart;

        await assertFunctionResponse(
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
        await devProc?.waitForExit().catch(() => undefined);
      }
    },
  );
});
