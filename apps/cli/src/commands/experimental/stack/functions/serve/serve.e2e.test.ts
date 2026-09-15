// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host filesystem APIs
import { mkdir, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host path APIs
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
  spawnSupabase,
} from "../../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const config = (ports: {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly edgeRuntimeInspectorPort: number;
}) => `project_id = "functions-serve-managed-e2e"

[experimental]
stack = true

[api]
enabled = false
port = ${ports.apiPort}

[db]
port = ${ports.dbPort}

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = true
inspector_port = ${ports.edgeRuntimeInspectorPort}

[functions.smoke]
verify_jwt = false

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
  const marker = Deno.env.get("FUNCTIONS_SERVE_E2E_MARKER") ?? null;
  console.log(\`functions-serve-managed-e2e marker=\${marker}\`);
  return Response.json({ marker });
});
`;

const apiUrlFromEnv = (stdout: string): string => {
  const match = stdout.match(/^API_URL=(.+)$/mu);
  if (match?.[1] === undefined) throw new Error(`stack status did not return API_URL:\n${stdout}`);
  return match[1];
};

describe("managed stack functions serve (compiled e2e)", () => {
  test.skipIf(!nativeSupported)(
    "applies invocation env and restores the running stack on Ctrl-C",
    { timeout: START_TIMEOUT_MS + COMMAND_TIMEOUT_MS },
    // oxlint-disable-next-line effecttsgo/async-function -- compiled CLI e2e callback is a Promise boundary
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-functions-serve-managed-e2e-");
      const supabaseDir = path.join(project.dir, "supabase");
      const functionDir = path.join(supabaseDir, "functions", "smoke");
      await mkdir(functionDir, { recursive: true });
      await writeFile(path.join(supabaseDir, "config.toml"), config(project.ports));
      await writeFile(path.join(functionDir, "index.ts"), functionSource);
      await writeFile(
        path.join(project.dir, "serve.env"),
        "FUNCTIONS_SERVE_E2E_MARKER=transient\n",
      );

      const started = await runSupabase(["stack", "start", "--runtime", "native"], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      expect(started.exitCode, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0);
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
      await expect(baseline.json()).resolves.toEqual({ marker: null });

      const served = spawnSupabase(["functions", "serve", "--env-file", "serve.env"], {
        cwd: project.dir,
        home: home.dir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: COMMAND_TIMEOUT_MS,
      });
      let exited = false;
      try {
        await served.waitForOutput(/Serving Functions on .*\/functions\/v1\/<function-name>/u);
        // oxlint-disable-next-line effecttsgo/global-fetch -- compiled CLI E2E invokes the local HTTP boundary
        const transient = await fetch(`${apiUrl}/functions/v1/smoke`);
        expect(transient.status).toBe(200);
        await expect(transient.json()).resolves.toEqual({ marker: "transient" });
        await served.waitForOutput(/functions-serve-managed-e2e marker=transient/u);

        served.kill("SIGINT");
        const result = await served.waitForExit(COMMAND_TIMEOUT_MS);
        exited = true;
        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
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
      await expect(restored.json()).resolves.toEqual({ marker: null });
      const status = await runSupabase(["stack", "status"], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: COMMAND_TIMEOUT_MS,
      });
      expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
      expect(status.stdout).toContain("Lifecycle: running");
    },
  );
});
