import { describe, expect, test } from "vitest";
import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
  spawnSupabase,
} from "../../../../tests/helpers/cli.ts";

const LOGS_TIMEOUT_MS = 15_000;
const LOGS_IDLE_WINDOW_MS = 500;
const LIGHTWEIGHT_START_ARGS = [
  "start",
  "--detach",
  "--exclude",
  "realtime",
  "--exclude",
  "storage",
  "--exclude",
  "imgproxy",
  "--exclude",
  "mailpit",
  "--exclude",
  "pgmeta",
  "--exclude",
  "studio",
  "--exclude",
  "analytics",
  "--exclude",
  "vector",
  "--exclude",
  "pooler",
] as const;

function extractApiUrl(output: string): string {
  const match = output.match(/API URL:\s+(http:\/\/\S+)/);
  if (match?.[1] == null) {
    throw new Error(`Could not find API URL in output:\n${output}`);
  }
  return match[1];
}

async function triggerAuthLog(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/auth/v1/signup`);
  expect(response.status).toBe(405);
}

async function waitForMatches(
  proc: ReturnType<typeof spawnSupabase>,
  pattern: RegExp,
  count: number,
  timeoutMs = LOGS_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matches = proc
      .stdout()
      .match(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes("g") ? "" : "g")));
    if ((matches?.length ?? 0) >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${count} matches of ${pattern}`);
}

describe("supabase logs", () => {
  test(
    "prints buffered history on attach and keeps following after an idle period",
    { timeout: LOGS_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-logs-e2e-");
      let logsProc: ReturnType<typeof spawnSupabase> | undefined;

      try {
        const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: LOGS_TIMEOUT_MS,
        });
        expect(startResult.exitCode).toBe(0);
        const apiUrl = extractApiUrl(startResult.stdout);

        await triggerAuthLog(apiUrl);

        logsProc = spawnSupabase(["logs"], {
          cwd: project.dir,
          home: home.dir,
          cleanupProcessGroupOnClose: false,
        });

        await waitForMatches(logsProc, /\[auth\].*"path":"\/signup"/, 1);

        await new Promise((resolve) => setTimeout(resolve, LOGS_IDLE_WINDOW_MS));
        await triggerAuthLog(apiUrl);
        await waitForMatches(logsProc, /\[auth\].*"path":"\/signup"/, 2);

        logsProc.kill("SIGTERM");

        const result = await logsProc.waitForExit();
        logsProc = undefined;

        expect(result.stderr).not.toContain("ECONNRESET");
        expect(result.stderr).not.toContain("The socket connection was closed unexpectedly");
      } finally {
        logsProc?.kill("SIGTERM");
        await logsProc?.waitForExit().catch(() => {});
      }
    },
  );
});
