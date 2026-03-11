import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase, spawnSupabase } from "../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 90_000;
const LOGS_IDLE_WINDOW_MS = 11_000;

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
  timeoutMs = START_TIMEOUT_MS,
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
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const startProc = spawnSupabase(["start"], {
        home: home.dir,
        cleanupProcessGroupOnClose: false,
      });
      let logsProc: ReturnType<typeof spawnSupabase> | undefined;

      try {
        await startProc.waitForOutput(/API URL:/, START_TIMEOUT_MS);
        const apiUrl = extractApiUrl(startProc.stdout());

        await triggerAuthLog(apiUrl);

        logsProc = spawnSupabase(["logs"], {
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
        startProc.kill("SIGTERM");
        await startProc.waitForExit().catch(() => {});
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test(
    "prints a bounded auth-only history snapshot and exits with --no-follow",
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const startProc = spawnSupabase(["start"], {
        home: home.dir,
        cleanupProcessGroupOnClose: false,
      });

      try {
        await startProc.waitForOutput(/API URL:/, START_TIMEOUT_MS);
        const apiUrl = extractApiUrl(startProc.stdout());
        await triggerAuthLog(apiUrl);

        const result = await runSupabase(["logs", "--service", "auth", "--no-follow"], {
          home: home.dir,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("[auth]");
        expect(result.stdout).toContain('"path":"/signup"');
        expect(result.stdout).not.toContain("[postgres]");
      } finally {
        startProc.kill("SIGTERM");
        await startProc.waitForExit().catch(() => {});
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test(
    "emits structured log-entry events in stream-json mode",
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const startProc = spawnSupabase(["start"], {
        home: home.dir,
        cleanupProcessGroupOnClose: false,
      });

      try {
        await startProc.waitForOutput(/API URL:/, START_TIMEOUT_MS);
        const apiUrl = extractApiUrl(startProc.stdout());
        await triggerAuthLog(apiUrl);

        const result = await runSupabase(
          ["logs", "--service", "auth", "--no-follow", "--output-format", "stream-json"],
          { home: home.dir },
        );

        expect(result.exitCode).toBe(0);
        const events = result.stdout
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);

        expect(events).toContainEqual(
          expect.objectContaining({
            type: "log-entry",
            service: "auth",
            source: "history",
            line: expect.stringContaining('"path":"/signup"'),
          }),
        );
      } finally {
        startProc.kill("SIGTERM");
        await startProc.waitForExit().catch(() => {});
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test("exits quietly on ctrl+c while following logs", { timeout: START_TIMEOUT_MS }, async () => {
    const home = makeTempHome();
    const startProc = spawnSupabase(["start"], {
      home: home.dir,
      cleanupProcessGroupOnClose: false,
    });
    let logsProc: ReturnType<typeof spawnSupabase> | undefined;

    try {
      await startProc.waitForOutput(/API URL:/, START_TIMEOUT_MS);
      const apiUrl = extractApiUrl(startProc.stdout());
      await triggerAuthLog(apiUrl);

      logsProc = spawnSupabase(["logs"], {
        home: home.dir,
        cleanupProcessGroupOnClose: false,
      });

      await waitForMatches(logsProc, /\[auth\].*"path":"\/signup"/, 1);
      logsProc.kill("SIGINT");

      const result = await logsProc.waitForExit();
      logsProc = undefined;

      expect(result.exitCode).toBe(130);
      expect(result.stderr).not.toContain("All fibers interrupted without error");
      expect(result.stderr.trim()).toBe("");
    } finally {
      logsProc?.kill("SIGTERM");
      await logsProc?.waitForExit().catch(() => {});
      startProc.kill("SIGTERM");
      await startProc.waitForExit().catch(() => {});
      await runSupabase(["stop"], { home: home.dir }).catch(() => {});
      home[Symbol.dispose]();
    }
  });
});
