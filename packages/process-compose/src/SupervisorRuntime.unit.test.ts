import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { makeSupervisorRuntimeEnv, withoutSupervisorRuntimeEnv } from "./supervisor-protocol.ts";

const supervisorRuntimePath = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));
const supervisorProtocolPath = fileURLToPath(new URL("./supervisor-protocol.ts", import.meta.url));

type SupervisorEntry = "source path" | "compiled self-dispatch";

const spawnSupervisor = (entry: SupervisorEntry, encodedConfig: string) => {
  if (entry === "source path") {
    return spawn(process.execPath, [supervisorRuntimePath, encodedConfig], {
      stdio: ["pipe", "ignore", "ignore"],
    });
  }

  const runtimeUrl = pathToFileURL(supervisorRuntimePath).href;
  const protocolUrl = pathToFileURL(supervisorProtocolPath).href;
  const dispatch = [
    `import { runSupervisorRuntimeFromEnv } from ${JSON.stringify(runtimeUrl)};`,
    `import { isSupervisorRuntimeRequested } from ${JSON.stringify(protocolUrl)};`,
    `if (!isSupervisorRuntimeRequested()) throw new Error("supervisor dispatch not requested");`,
    `runSupervisorRuntimeFromEnv();`,
  ].join("\n");
  return spawn(process.execPath, ["--eval", dispatch], {
    env: makeSupervisorRuntimeEnv(encodedConfig, {
      ...process.env,
      PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH: "1",
    }),
    stdio: ["pipe", "ignore", "ignore"],
  });
};

const waitFor = async (
  predicate: () => boolean,
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<void> => {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for condition");
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("supervisor-runtime", () => {
  test.each<SupervisorEntry>(["source path", "compiled self-dispatch"])(
    "%s kills the child tree and runs validated orphan cleanup when parent stdin closes",
    { timeout: 15_000 },
    async (entry) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-"));
      const cleanupDir = path.join(tempDir, "cleanup-dir");
      const cleanupMarker = path.join(tempDir, "cleanup-command-ran");
      const cleanupEnvironmentMarker = path.join(tempDir, "cleanup-environment.json");
      const childPidFile = path.join(tempDir, "child.pid");
      const grandchildPidFile = path.join(tempDir, "grandchild.pid");
      const readyFile = path.join(tempDir, "ready");
      const childScriptPath = path.join(tempDir, "child.mjs");

      mkdirSync(cleanupDir);
      writeFileSync(
        childScriptPath,
        [
          `import { spawn } from "node:child_process";`,
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
          `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
          `if (grandchild.pid != null) writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
          `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
          `process.on("SIGTERM", () => {});`,
          `process.on("SIGINT", () => {});`,
          `setInterval(() => {}, 1000);`,
        ].join("\n"),
      );

      const encodedConfig = Buffer.from(
        JSON.stringify({
          command: process.execPath,
          args: [childScriptPath],
          shutdownSignal: "SIGTERM",
          shutdownTimeoutMs: 100,
          cleanup: [
            { _tag: "RemovePath", path: cleanupDir, recursive: true },
            {
              _tag: "RunCommand",
              executable: process.execPath,
              args: [
                "-e",
                [
                  `const { writeFileSync } = require("node:fs");`,
                  `writeFileSync(process.argv[1], process.argv[2]);`,
                  `writeFileSync(process.argv[3], JSON.stringify({`,
                  `  run: process.env.PROCESS_COMPOSE_RUN_SUPERVISOR,`,
                  `  config: process.env.PROCESS_COMPOSE_SUPERVISOR_CONFIG,`,
                  `  dispatch: process.env.PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH,`,
                  `}));`,
                ].join("\n"),
                cleanupMarker,
                "literal; $(not-run) & value",
                cleanupEnvironmentMarker,
              ],
            },
          ],
        }),
      ).toString("base64url");

      const supervisor = spawnSupervisor(entry, encodedConfig);

      try {
        await waitFor(() => existsSync(readyFile));

        const childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
        const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);

        supervisor.stdin.end();

        await waitFor(() => supervisor.exitCode != null, { timeoutMs: 10_000 });
        await waitFor(() => !existsSync(cleanupDir), { timeoutMs: 10_000 });
        await waitFor(() => existsSync(cleanupMarker), { timeoutMs: 10_000 });
        expect(readFileSync(cleanupMarker, "utf8")).toBe("literal; $(not-run) & value");
        expect(JSON.parse(readFileSync(cleanupEnvironmentMarker, "utf8"))).toEqual({});
        await waitFor(() => !isPidAlive(childPid), { timeoutMs: 10_000 });
        await waitFor(() => !isPidAlive(grandchildPid), { timeoutMs: 10_000 });
      } finally {
        supervisor.kill("SIGKILL");
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    [
      "non-string command argument",
      { _tag: "RunCommand", executable: process.execPath, args: [42] },
    ],
    ["empty executable", { _tag: "RunCommand", executable: "", args: [] }],
    [
      "non-positive timeout",
      { _tag: "RunCommand", executable: process.execPath, args: [], timeoutMs: 0 },
    ],
    ["invalid path option", { _tag: "RemovePath", path: "/tmp/example", recursive: "yes" }],
  ])("rejects a malformed cleanup contract with %s before spawning", async (_name, cleanup) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-invalid-"));
    const childMarker = path.join(tempDir, "child-started");
    const encodedConfig = Buffer.from(
      JSON.stringify({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(childMarker)}, "started")`],
        cleanup: [cleanup],
      }),
    ).toString("base64url");
    const supervisor = spawnSupervisor("source path", encodedConfig);

    try {
      await waitFor(() => supervisor.exitCode != null);
      expect(supervisor.exitCode).not.toBe(0);
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      supervisor.kill("SIGKILL");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("removes supervisor protocol variables from the managed child environment", () => {
    const childEnv = withoutSupervisorRuntimeEnv({
      KEEP_ME: "value",
      PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH: "1",
      PROCESS_COMPOSE_RUN_SUPERVISOR: "1",
      PROCESS_COMPOSE_SUPERVISOR_CONFIG: "encoded",
    });

    expect(childEnv).toEqual({ KEEP_ME: "value" });
  });

  test("bounds a cleanup command tree by its timeout and continues remaining cleanup", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-timeout-"));
    const cleanupDir = path.join(tempDir, "cleanup-dir");
    const cleanupWorkerPidFile = path.join(tempDir, "cleanup-worker.pid");
    const childScriptPath = path.join(tempDir, "child.mjs");
    mkdirSync(cleanupDir);
    writeFileSync(childScriptPath, "process.exit(0);\n");
    const encodedConfig = Buffer.from(
      JSON.stringify({
        command: process.execPath,
        args: [childScriptPath],
        cleanup: [
          {
            _tag: "RunCommand",
            executable: process.execPath,
            args: [
              "-e",
              [
                `const { spawn } = require("node:child_process");`,
                `const { writeFileSync } = require("node:fs");`,
                `const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
                `writeFileSync(${JSON.stringify(cleanupWorkerPidFile)}, String(worker.pid));`,
                `setInterval(() => {}, 1000);`,
              ].join("\n"),
            ],
            timeoutMs: 100,
          },
          { _tag: "RemovePath", path: cleanupDir, recursive: true },
        ],
      }),
    ).toString("base64url");
    const supervisor = spawnSupervisor("source path", encodedConfig);

    try {
      await waitFor(() => supervisor.exitCode != null);
      expect(supervisor.exitCode).toBe(0);
      expect(existsSync(cleanupDir)).toBe(false);
      const cleanupWorkerPid = Number.parseInt(readFileSync(cleanupWorkerPidFile, "utf8"), 10);
      expect(Number.isSafeInteger(cleanupWorkerPid)).toBe(true);
      await waitFor(() => !isPidAlive(cleanupWorkerPid));
    } finally {
      supervisor.kill("SIGKILL");
      if (existsSync(cleanupWorkerPidFile)) {
        try {
          process.kill(Number.parseInt(readFileSync(cleanupWorkerPidFile, "utf8"), 10), "SIGKILL");
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("bounds a cleanup command when no timeout is configured", { timeout: 12_000 }, async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-timeout-"));
    const cleanupDir = path.join(tempDir, "cleanup-dir");
    const cleanupPidFile = path.join(tempDir, "cleanup.pid");
    const childScriptPath = path.join(tempDir, "child.mjs");
    mkdirSync(cleanupDir);
    writeFileSync(childScriptPath, "process.exit(0);\n");
    const encodedConfig = Buffer.from(
      JSON.stringify({
        command: process.execPath,
        args: [childScriptPath],
        cleanup: [
          {
            _tag: "RunCommand",
            executable: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(cleanupPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
            ],
          },
          { _tag: "RemovePath", path: cleanupDir, recursive: true },
        ],
      }),
    ).toString("base64url");
    const supervisor = spawnSupervisor("source path", encodedConfig);

    try {
      await waitFor(() => supervisor.exitCode != null, { timeoutMs: 8_000 });
      expect(supervisor.exitCode).toBe(0);
      expect(existsSync(cleanupDir)).toBe(false);
    } finally {
      supervisor.kill("SIGKILL");
      if (existsSync(cleanupPidFile)) {
        try {
          process.kill(Number.parseInt(readFileSync(cleanupPidFile, "utf8"), 10), "SIGKILL");
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test(
    "runs orphan cleanup when the configured owner pid is already gone",
    { timeout: 15_000 },
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-"));
      const cleanupDir = path.join(tempDir, "cleanup-dir");
      const childScriptPath = path.join(tempDir, "child.mjs");

      mkdirSync(cleanupDir);
      writeFileSync(childScriptPath, `setInterval(() => {}, 1000);\n`);

      const encodedConfig = Buffer.from(
        JSON.stringify({
          command: process.execPath,
          args: [childScriptPath],
          ownerPid: 999_999_999,
          shutdownSignal: "SIGTERM",
          shutdownTimeoutMs: 100,
          cleanup: [{ _tag: "RemovePath", path: cleanupDir, recursive: true }],
        }),
      ).toString("base64url");

      const supervisor = spawn(process.execPath, [supervisorRuntimePath, encodedConfig], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      try {
        await waitFor(() => supervisor.exitCode != null, { timeoutMs: 10_000 });
        await waitFor(() => !existsSync(cleanupDir), { timeoutMs: 10_000 });
      } finally {
        supervisor.kill("SIGKILL");
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
