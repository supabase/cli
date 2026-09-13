// Starts a native stack through the compiled CLI binary, checks its status and connection-variable
// export, stops it, checks status again, then uses the package's public Promise API to inspect and
// destroy that stack.
// oxlint-disable-next-line effecttsgo/process-env -- package runtime composition is scoped below.

// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host process/filesystem APIs
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host process/filesystem APIs
import { execFile as execFileCallback } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- compiled CLI fixture requires host process/filesystem APIs
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempHome, runSupabase, spawnSupabase } from "../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const execFile = promisify(execFileCallback);
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const minimalConfig = `project_id = "compiled-stack-start-e2e"

[experimental]
stack = true

[api]
enabled = false

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = false

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

// oxlint-disable-next-line effecttsgo/async-function -- subprocess inspection is a foreign Promise boundary
async function inspectStackState(home: string, stackId: string) {
  const script = `
    import { inspectStack, openStack, StackIdSchema } from "@supabase/stack";
    const id = StackIdSchema.make(process.argv.at(-1));
    const inspection = await inspectStack(id);
    const stack = await openStack(id);
    const status = await stack.status();
    const credentials =
      status.lifecycle === "running" ? await stack.credentials() : undefined;
    console.log(JSON.stringify({
      owner: inspection.owner,
      projectRoot: inspection.descriptor.projectRoot,
      runtime: status.runtime,
      lifecycle: status.lifecycle,
      database: status.capabilities.find(({ name }) => name === "database")?.state,
      databaseUrl: credentials?.database.url,
      hasApi: credentials?.api !== undefined,
    }));
  `;
  const result = await execFile("bun", ["--bun", "-e", script, stackId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPABASE_HOME: home,
      SUPABASE_NO_KEYRING: "1",
      SUPABASE_TELEMETRY_DISABLED: "1",
    },
    timeout: CLEANUP_TIMEOUT_MS,
  });
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error(`Stack probe returned no result:\n${result.stderr}`);
  return JSON.parse(line) as {
    readonly owner: string;
    readonly projectRoot: string;
    readonly runtime: { readonly kind: string };
    readonly lifecycle: string;
    readonly database: string | undefined;
    readonly databaseUrl: string | undefined;
    readonly hasApi: boolean;
  };
}

// oxlint-disable-next-line effecttsgo/async-function -- subprocess cleanup is a foreign Promise boundary
async function destroyStack(home: string, stackId: string) {
  const script = `
    import { openStack, StackIdSchema } from "@supabase/stack";
    const stack = await openStack(StackIdSchema.make(process.argv.at(-1)));
    await stack.destroy();
  `;
  await execFile("bun", ["--bun", "-e", script, stackId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPABASE_HOME: home,
      SUPABASE_NO_KEYRING: "1",
      SUPABASE_TELEMETRY_DISABLED: "1",
    },
    timeout: CLEANUP_TIMEOUT_MS,
  });
}

describe("stack start (compiled e2e)", () => {
  let home: ReturnType<typeof makeTempHome> | undefined;
  let projectDir: string | undefined;
  let stackId: string | undefined;
  let stackDestroyed = false;

  // oxlint-disable-next-line effecttsgo/async-function -- Vitest cleanup callback is a Promise boundary
  afterEach(async () => {
    let cleanupComplete = stackDestroyed;
    if (!cleanupComplete && home !== undefined) {
      const candidates = await readdir(path.join(home.dir, "managed", "stacks")).catch(
        () => [] as Array<string>,
      );
      const discovered = candidates.filter((entry) => /^[0-9a-f]{64}$/u.test(entry));
      const ownedId = stackId ?? (discovered.length === 1 ? discovered[0] : undefined);
      if (ownedId !== undefined) {
        await destroyStack(home.dir, ownedId);
        cleanupComplete = true;
      } else if (discovered.length > 1) {
        throw new Error(`Could not identify one owned stack for cleanup: ${discovered.join(", ")}`);
      } else {
        cleanupComplete = true;
      }
    }
    if (!cleanupComplete) return;
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    home?.[Symbol.dispose]();
    home = undefined;
    projectDir = undefined;
    stackId = undefined;
    stackDestroyed = false;
  }, CLEANUP_TIMEOUT_MS);

  test.skipIf(!nativeSupported)(
    "starts and stops a native stack while preserving its database",
    { timeout: START_TIMEOUT_MS + CLEANUP_TIMEOUT_MS },
    // oxlint-disable-next-line effecttsgo/async-function -- compiled CLI e2e callback is a Promise boundary
    async () => {
      home = makeTempHome();
      projectDir = await mkdtemp(path.join("/tmp", "supabase-compiled-stack-start-e2e-"));
      await mkdir(path.join(projectDir, "supabase"), { recursive: true });
      await writeFile(path.join(projectDir, "supabase", "config.toml"), minimalConfig);

      const result = await runSupabase(["stack", "start", "--runtime", "native", "--eager"], {
        cwd: projectDir,
        home: home.dir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const idMatch = result.stdout.match(/Stack ([0-9a-f]{64})/u);
      expect(idMatch, `stdout:\n${result.stdout}`).not.toBeNull();
      stackId = idMatch?.[1];
      const idText = stackId;
      const homeDir = home;
      const projectRoot = projectDir;
      if (idText === undefined || homeDir === undefined || projectRoot === undefined)
        throw new Error("compiled start did not return a stack id");

      const running = await inspectStackState(homeDir.dir, idText);
      expect(running.owner).toBe("running");
      expect(running.projectRoot).toBe(await realpath(projectRoot));
      expect(running.runtime).toEqual({ kind: "native" });
      expect(running.lifecycle).toBe("running");
      expect(running.database).toBe("ready");
      expect(running.hasApi).toBe(false);
      expect(running.databaseUrl).toMatch(
        /^postgresql:\/\/postgres:.+@127\.0\.0\.1:\d+\/postgres$/,
      );
      const databasePath = path.join(homeDir.dir, "managed", "stacks", idText, "data", "database");
      await access(path.join(databasePath, "PG_VERSION"));

      const logs = await runSupabase(
        [
          "stack",
          "logs",
          "--stack-id",
          idText,
          "--service",
          "database",
          "--tail",
          "100",
          "--output-format",
          "json",
        ],
        {
          cwd: projectRoot,
          home: homeDir.dir,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: CLEANUP_TIMEOUT_MS,
        },
      );
      expect(logs.exitCode, `stdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`).toBe(0);
      const logData = JSON.parse(logs.stdout) as {
        readonly found: boolean;
        readonly id: string;
        readonly entries: ReadonlyArray<{
          readonly source: string;
          readonly message: string;
        }>;
      };
      expect(logData.found).toBe(true);
      expect(logData.id).toBe(idText);
      expect(logData.entries.length).toBeGreaterThan(0);
      expect(logData.entries.every((entry) => entry.source === "database")).toBe(true);

      const followed = spawnSupabase(
        [
          "stack",
          "logs",
          "--stack-id",
          idText,
          "--service",
          "database",
          "--tail",
          "1",
          "--follow",
          "--output-format",
          "stream-json",
        ],
        {
          cwd: projectRoot,
          home: homeDir.dir,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: CLEANUP_TIMEOUT_MS,
        },
      );
      let followerExited = false;
      try {
        await followed.waitForOutput(
          /"type":"log-entry".*"service":"database".*"source":"history"/u,
          START_TIMEOUT_MS,
        );
        followed.kill("SIGINT");
        const followResult = await followed.waitForExit(CLEANUP_TIMEOUT_MS);
        followerExited = true;
        expect(
          followResult.exitCode,
          `stdout:\n${followResult.stdout}\nstderr:\n${followResult.stderr}`,
        ).toBe(130);
        const followEvents = followResult.stdout
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly type: string;
                readonly service?: string;
                readonly source?: string;
              },
          );
        const historyEntries = followEvents.filter(
          (event) => event.type === "log-entry" && event.source === "history",
        );
        expect(historyEntries).toHaveLength(1);
        expect(historyEntries[0]).toEqual(expect.objectContaining({ service: "database" }));
      } finally {
        if (!followerExited) {
          followed.kill("SIGKILL");
          await followed.waitForExit(CLEANUP_TIMEOUT_MS);
        }
      }

      const afterFollow = await inspectStackState(homeDir.dir, idText);
      expect(afterFollow.owner).toBe("running");
      expect(afterFollow.lifecycle).toBe("running");
      expect(afterFollow.database).toBe("ready");
      const status = await runSupabase(["stack", "status", "--stack-id", idText], {
        cwd: projectRoot,
        home: homeDir.dir,
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
      expect(status.stdout).toContain(`(${idText})`);
      expect(status.stdout).toContain("Owner: running");
      expect(status.stdout).toContain("Lifecycle: running");
      expect(status.stdout).toContain("Readiness: ready");
      expect(status.stdout).toMatch(/Config drift: (changed|unchanged)/u);

      const topLevelStatus = await runSupabase(["status", "--stack-id", idText], {
        cwd: projectRoot,
        home: homeDir.dir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      expect(
        topLevelStatus.exitCode,
        `stdout:\n${topLevelStatus.stdout}\nstderr:\n${topLevelStatus.stderr}`,
      ).toBe(0);
      expect(topLevelStatus.stdout).toContain(`(${idText})`);
      expect(topLevelStatus.stdout).toContain("Owner: running");
      expect(topLevelStatus.stdout).toContain("Lifecycle: running");

      const env = await runSupabase(
        ["stack", "status", "--env", "--stack-id", idText, "--output-format", "json"],
        { cwd: projectRoot, home: homeDir.dir, exitTimeoutMs: CLEANUP_TIMEOUT_MS },
      );
      expect(env.exitCode, `stdout:\n${env.stdout}\nstderr:\n${env.stderr}`).toBe(0);
      const variables = JSON.parse(env.stdout) as Record<string, string>;
      expect(Object.keys(variables)).toEqual(["DB_URL"]);
      expect(variables.DB_URL).toMatch(/^postgresql:\/\/postgres:.+@.+:\d+\/postgres$/u);

      const dotenv = await runSupabase(
        ["stack", "status", "--env", "--stack-id", idText, "--output-format", "text"],
        { cwd: projectRoot, home: homeDir.dir, exitTimeoutMs: CLEANUP_TIMEOUT_MS },
      );
      expect(dotenv.exitCode, `stdout:\n${dotenv.stdout}\nstderr:\n${dotenv.stderr}`).toBe(0);
      expect(parseDotenv(dotenv.stdout)).toEqual(variables);

      await rm(path.join(projectRoot, "supabase", "config.toml"));
      const stop = await runSupabase(["stack", "stop", "--stack-id", idText], {
        cwd: projectRoot,
        home: homeDir.dir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);

      const observed = await inspectStackState(homeDir.dir, idText);
      expect(observed.owner).toBe("absent");
      expect(observed.projectRoot).toBe(await realpath(projectRoot));
      expect(observed.runtime).toEqual({ kind: "native" });
      expect(observed.lifecycle).toBe("stopped");
      expect(observed.database).toBe("stopped");

      const stoppedStatus = await runSupabase(["stack", "status", "--stack-id", idText], {
        cwd: projectRoot,
        home: homeDir.dir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      expect(
        stoppedStatus.exitCode,
        `stdout:\n${stoppedStatus.stdout}\nstderr:\n${stoppedStatus.stderr}`,
      ).toBe(0);
      expect(stoppedStatus.stdout).toContain("Owner: absent");
      expect(stoppedStatus.stdout).toContain("Lifecycle: unavailable");
      expect(stoppedStatus.stdout).toContain("Readiness: unknown");

      const stoppedEnv = await runSupabase(["stack", "status", "--env", "--stack-id", idText], {
        cwd: projectRoot,
        home: homeDir.dir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      expect(stoppedEnv.exitCode).not.toBe(0);
      expect(stoppedEnv.stdout).not.toContain("DB_URL");
      expect(stoppedEnv.stderr).toContain("must be running");

      await access(path.join(databasePath, "PG_VERSION"));

      const retainedLogs = await runSupabase(
        [
          "stack",
          "logs",
          "--stack-id",
          idText,
          "--service",
          "database",
          "--tail",
          "100",
          "--output-format",
          "json",
        ],
        {
          cwd: projectRoot,
          home: homeDir.dir,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: CLEANUP_TIMEOUT_MS,
        },
      );
      expect(
        retainedLogs.exitCode,
        `stdout:\n${retainedLogs.stdout}\nstderr:\n${retainedLogs.stderr}`,
      ).toBe(0);
      const retainedData = JSON.parse(retainedLogs.stdout) as {
        readonly found: boolean;
        readonly id: string;
        readonly running: boolean;
        readonly entries: ReadonlyArray<{ readonly source: string }>;
      };
      expect(retainedData.found).toBe(true);
      expect(retainedData.id).toBe(idText);
      expect(retainedData.running).toBe(false);
      expect(retainedData.entries.length).toBeGreaterThan(0);
      expect(retainedData.entries.every((entry) => entry.source === "database")).toBe(true);

      await destroyStack(homeDir.dir, idText);
      stackDestroyed = true;

      await expect(access(path.join(homeDir.dir, "managed", "stacks", idText))).rejects.toThrow();
    },
  );
});
