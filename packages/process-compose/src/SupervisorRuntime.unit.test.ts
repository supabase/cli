import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const supervisorRuntimePath = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));

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
  test(
    "kills the child tree and runs orphan cleanup when parent stdin closes",
    { timeout: 15_000 },
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "process-compose-supervisor-"));
      const cleanupDir = path.join(tempDir, "cleanup-dir");
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
          cleanup: [{ _tag: "RemovePath", path: cleanupDir, recursive: true }],
        }),
      ).toString("base64url");

      const supervisor = spawn(process.execPath, [supervisorRuntimePath, encodedConfig], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      try {
        await waitFor(() => existsSync(readyFile));

        const childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
        const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);

        supervisor.stdin.end();

        await waitFor(() => supervisor.exitCode != null, { timeoutMs: 10_000 });
        await waitFor(() => !existsSync(cleanupDir), { timeoutMs: 10_000 });
        await waitFor(() => !isPidAlive(childPid), { timeoutMs: 10_000 });
        await waitFor(() => !isPidAlive(grandchildPid), { timeoutMs: 10_000 });
      } finally {
        supervisor.kill("SIGKILL");
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

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
