// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host filesystem APIs
import { mkdir, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host path APIs
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  spawnSupabase,
} from "../../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const nativeAvailable =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const config = (projectId: string) => `project_id = "${projectId}"

[experimental]
stack = true

[db.pooler]
enabled = false

[edge_runtime]
enabled = true
secrets = { EXPLICIT_WINS = "config-value", CONFIG_ONLY = "config-only" }

[functions.smoke]
verify_jwt = false
env = { FUNCTION_ONLY = "env(FUNCTION_ONLY_SOURCE)" }

[realtime]
enabled = false

[storage]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[local_smtp]
enabled = false
`;

const functionSource = `Deno.serve(() => {
  const values = {
    explicitWins: Deno.env.get("EXPLICIT_WINS") ?? null,
    configOnly: Deno.env.get("CONFIG_ONLY") ?? null,
    functionOnly: Deno.env.get("FUNCTION_ONLY") ?? null,
    multiline: Deno.env.get("MULTILINE_VALUE") ?? null,
    reserved: Deno.env.get("SUPABASE_SERVE_E2E_RESERVED") ?? null,
  };
  return Response.json(values);
});
`;

const apiUrlFromEnv = (stdout: string): string => {
  const match = stdout.match(/^API_URL='([^']+)'$/mu);
  if (match?.[1] === undefined) throw new Error(`stack status did not return API_URL:\n${stdout}`);
  return match[1];
};

describe("managed stack functions serve compiled e2e", () => {
  test.skipIf(!nativeAvailable)(
    "applies invocation overrides and restores the running stack on Ctrl-C",
    { timeout: START_TIMEOUT_MS + COMMAND_TIMEOUT_MS },
    // oxlint-disable-next-line effecttsgo/async-function -- compiled CLI e2e callback is a Promise boundary
    async () => {
      const home = makeTempHome();
      const project = await makeTempCliProject("supabase-functions-serve-native-e2e-");
      const projectId = path.basename(project.dir);
      const supabaseDir = path.join(project.dir, "supabase");
      const functionDir = path.join(supabaseDir, "functions", "smoke");
      await mkdir(functionDir, { recursive: true });
      await writeFile(path.join(supabaseDir, "config.toml"), config(projectId));
      await writeFile(path.join(functionDir, "index.ts"), functionSource);
      await writeFile(path.join(project.dir, ".env"), "FUNCTION_ONLY_SOURCE=function-only\n");
      await writeFile(
        path.join(project.dir, "serve.env"),
        [
          "EXPLICIT_WINS=explicit-value",
          'MULTILINE_VALUE="first line',
          'second line"',
          "SUPABASE_SERVE_E2E_RESERVED=must-not-reach-runtime",
          "",
        ].join("\n"),
      );

      const started = await runSupabase(["stack", "start", "--runtime", "native", "--eager"], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      await using _stackCleanup = {
        // oxlint-disable-next-line effecttsgo/async-function -- compiled CLI E2E cleanup is a Promise boundary
        async [Symbol.asyncDispose]() {
          if (started.exitCode !== 0) return;
          const destroyed = await runSupabase(["stack", "destroy", "--yes"], {
            cwd: project.dir,
            home: home.dir,
            exitTimeoutMs: COMMAND_TIMEOUT_MS,
          });
          expect(
            destroyed.exitCode,
            `stdout:\n${destroyed.stdout}\nstderr:\n${destroyed.stderr}`,
          ).toBe(0);
        },
      };
      const startDiagnostics =
        started.exitCode === 0
          ? undefined
          : await runSupabase(["stack", "logs", "--service", "functions", "--tail", "100"], {
              cwd: project.dir,
              home: home.dir,
              exitTimeoutMs: COMMAND_TIMEOUT_MS,
            });
      expect(
        started.exitCode,
        [
          `stdout:\n${started.stdout}`,
          `stderr:\n${started.stderr}`,
          ...(startDiagnostics === undefined
            ? []
            : [
                `Functions logs stdout:\n${startDiagnostics.stdout}`,
                `Functions logs stderr:\n${startDiagnostics.stderr}`,
              ]),
        ].join("\n"),
      ).toBe(0);
      const env = await runSupabase(["stack", "status", "--env"], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: COMMAND_TIMEOUT_MS,
      });
      expect(env.exitCode, `stdout:\n${env.stdout}\nstderr:\n${env.stderr}`).toBe(0);
      const apiUrl = apiUrlFromEnv(env.stdout);
      // oxlint-disable-next-line effecttsgo/global-fetch -- compiled CLI E2E invokes the local HTTP boundary
      const baseline = await fetch(`${apiUrl}/functions/v1/smoke`);
      expect(baseline.status).toBe(200);
      await expect(baseline.json()).resolves.toEqual({
        explicitWins: "config-value",
        configOnly: "config-only",
        functionOnly: "function-only",
        multiline: null,
        reserved: null,
      });

      const served = spawnSupabase(
        ["functions", "serve", "--env-file", "serve.env", "--inspect-mode", "run"],
        {
          cwd: project.dir,
          home: home.dir,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: COMMAND_TIMEOUT_MS,
        },
      );
      let exited = false;
      try {
        try {
          await served.waitForOutput(/Serving Functions on .*\/functions\/v1\/<function-name>/u);
        } catch (cause) {
          const diagnostics = await runSupabase(
            ["stack", "logs", "--service", "functions", "--tail", "100"],
            {
              cwd: project.dir,
              home: home.dir,
              exitTimeoutMs: COMMAND_TIMEOUT_MS,
            },
          );
          throw new Error(
            `${String(cause)}\nFunctions logs stdout:\n${diagnostics.stdout}\nFunctions logs stderr:\n${diagnostics.stderr}`,
          );
        }
        // oxlint-disable-next-line effecttsgo/global-fetch -- compiled CLI E2E invokes the local HTTP boundary
        const transient = await fetch(`${apiUrl}/functions/v1/smoke`);
        expect(transient.status).toBe(200);
        await expect(transient.json()).resolves.toEqual({
          explicitWins: "explicit-value",
          configOnly: "config-only",
          functionOnly: "function-only",
          multiline: "first line\nsecond line",
          reserved: null,
        });
        await served.waitForOutput(/Debugger listening on ws:\/\/.*:\d+/iu);

        served.kill("SIGINT");
        const result = await served.waitForExit(COMMAND_TIMEOUT_MS);
        exited = true;
        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
        expect(result.stderr).toContain("Setting up Edge Functions runtime");
        expect(result.stderr).toContain(
          "Env name cannot start with SUPABASE_, skipping: SUPABASE_SERVE_E2E_RESERVED",
        );
        expect(result.stdout).toContain("Stopped serving supabase/functions");
      } finally {
        if (!exited) {
          served.kill("SIGKILL");
          await served.waitForExit(COMMAND_TIMEOUT_MS);
        }
      }

      // oxlint-disable-next-line effecttsgo/global-fetch -- compiled CLI E2E invokes the local HTTP boundary
      const restored = await fetch(`${apiUrl}/functions/v1/smoke`);
      expect(restored.status).toBe(200);
      await expect(restored.json()).resolves.toEqual({
        explicitWins: "config-value",
        configOnly: "config-only",
        functionOnly: "function-only",
        multiline: null,
        reserved: null,
      });
      const stackStatus = await runSupabase(["stack", "status"], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: COMMAND_TIMEOUT_MS,
      });
      expect(
        stackStatus.exitCode,
        `stdout:\n${stackStatus.stdout}\nstderr:\n${stackStatus.stderr}`,
      ).toBe(0);
      expect(stackStatus.stdout).toContain("Lifecycle: running");
    },
  );
});
