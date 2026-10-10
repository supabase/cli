import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSpawnRun,
  KILL_GRACE_MS,
  releaseAssets,
  uploadAssets,
  uploadedAssetNames,
  type ReleaseIo,
  type RunResult,
} from "./upload-release-assets.ts";

const scriptPath = fileURLToPath(new URL("./upload-release-assets.ts", import.meta.url));
const asset = {
  path: "dist/supabase_1.0.0_darwin_arm64.tar.gz",
  name: "supabase_1.0.0_darwin_arm64.tar.gz",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type FakeGhMode = "succeed" | "fail" | "hang" | "ignore-term";

const fakeGh = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$*" >> "$dir/calls.log"
if [ "$1 $2" = "release view" ]; then
  cat "$dir/view.json"
  exit 0
fi
case "$FAKE_GH_MODE" in
  fail)
    echo "HTTP 500: Error saving asset" >&2
    exit 1
    ;;
  hang)
    echo ready > "$FAKE_GH_READY_FIFO" || exit 97
    exec sleep 30
    ;;
  ignore-term)
    trap '' TERM # sleep inherits the ignored SIGTERM across exec, so only SIGKILL stops it.
    echo ready > "$FAKE_GH_READY_FIFO" || exit 97
    exec sleep 30
    ;;
  *)
    exit 0
    ;;
esac
`;

async function fakeGhOnPath() {
  const directory = await mkdtemp(path.join(tmpdir(), "upload-release-assets-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), fakeGh);
  await chmod(path.join(bin, "gh"), 0o755);
  const env = {
    ...process.env,
    FAKE_GH_DIR: directory,
    FAKE_GH_MODE: "succeed",
    PATH: `${bin}:${process.env.PATH}`,
  };
  const calls = async () =>
    (await readFile(path.join(directory, "calls.log"), "utf8")).trimEnd().split("\n");
  return { directory, env, calls };
}

function mkfifo(fifoPath: string): void {
  execFileSync("mkfifo", [fifoPath]);
}

/**
 * Waits for the child to signal readiness over the FIFO, racing it against the child's own exit
 * so a child that never opens the FIFO (env var drift, spawn failure) fails fast with its exit
 * code and stderr instead of leaking a blocked `open()` on the threadpool.
 */
async function awaitReady(fifoPath: string, result: Promise<RunResult>): Promise<void> {
  let readerOpened = false;
  const readyLine = open(fifoPath, "r").then(async (fd) => {
    readerOpened = true;
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      return buffer.toString("utf8", 0, bytesRead).trim();
    } finally {
      await fd.close();
    }
  });
  const exitedFirst = result.then((settled) => {
    throw new Error(
      `fake gh exited before signaling readiness (exit ${settled.exitCode}): ${settled.stderr.trim()}`,
    );
  });

  try {
    expect(await Promise.race([readyLine, exitedFirst])).toBe("ready");
  } catch (cause) {
    // Opening the write end releases a reader still blocked on open(); with no reader it would block.
    if (!readerOpened) await open(fifoPath, "w").then((fd) => fd.close());
    throw cause;
  }
}

function deterministicRun(
  directory: string,
  env: Record<string, string | undefined>,
  modesByAttempt: readonly FakeGhMode[],
): { run: ReleaseIo["run"]; attempts: string[][]; results: RunResult[] } {
  const attempts: string[][] = [];
  const results: RunResult[] = [];
  let attemptIndex = 0;

  const run: ReleaseIo["run"] = async (argv, options) => {
    attemptIndex += 1;
    attempts.push(argv);
    const mode = modesByAttempt[attemptIndex - 1] ?? "succeed";

    const readyFifo = path.join(directory, `ready-${attemptIndex}.fifo`);
    const hangs = mode === "hang" || mode === "ignore-term";
    if (hangs) mkfifo(readyFifo);

    const spawnRun = createSpawnRun({ ...env, FAKE_GH_MODE: mode, FAKE_GH_READY_FIFO: readyFifo });
    const resultPromise = spawnRun(argv, options);

    if (hangs) {
      // Wait for the child to reach the hang so the timer advance below isn't a guess.
      await awaitReady(readyFifo, resultPromise);
      await vi.advanceTimersByTimeAsync(options.timeoutMs); // SIGTERM
    }
    if (mode === "ignore-term") {
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
      expect(vi.getTimerCount()).toBeGreaterThan(0); // the SIGKILL timer hasn't fired yet
      await vi.advanceTimersByTimeAsync(1); // SIGKILL
    }

    const result = await resultPromise;
    results.push(result);
    return result;
  };

  return { run, attempts, results };
}

function recordingIo(run: ReleaseIo["run"]): { io: ReleaseIo; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    io: {
      run,
      fileExists: async () => true,
      sleep: () => Promise.resolve(),
      log: (line) => {
        logs.push(line);
      },
    },
  };
}

describe("upload-release-assets against a fake gh", () => {
  test("kills an upload that outlives the timeout and succeeds on the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { directory, env } = await fakeGhOnPath();
      const { run, attempts, results } = deterministicRun(directory, env, ["hang"]);
      const { io, logs } = recordingIo(run);

      await uploadAssets("v1.0.0", [asset], io, {
        maxAttempts: 2,
        timeoutMs: 500,
        backoffMs: () => 0,
      });

      expect(attempts).toEqual([
        ["gh", "release", "upload", "v1.0.0", asset.path, "--clobber"],
        ["gh", "release", "upload", "v1.0.0", asset.path, "--clobber"],
      ]);
      expect(results[0]?.timedOut).toBe(true);
      expect(results[0]?.exitCode).toBe(143); // SIGTERM
      expect(results[1]?.exitCode).toBe(0);
      expect(logs).toEqual([
        `Upload of ${asset.name} failed on attempt 1 (timed out after 0.5s); retrying in 0s.`,
        `Uploaded ${asset.name} (attempt 2).`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test("kills an upload that ignores SIGTERM once the grace period passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { directory, env } = await fakeGhOnPath();
      const { run, attempts, results } = deterministicRun(directory, env, ["ignore-term"]);
      const { io, logs } = recordingIo(run);

      await uploadAssets("v1.0.0", [asset], io, {
        maxAttempts: 2,
        timeoutMs: 500,
        backoffMs: () => 0,
      });

      expect(attempts).toEqual([
        ["gh", "release", "upload", "v1.0.0", asset.path, "--clobber"],
        ["gh", "release", "upload", "v1.0.0", asset.path, "--clobber"],
      ]);
      expect(results[0]?.timedOut).toBe(true);
      expect(results[0]?.exitCode).toBe(137); // SIGKILL; SIGTERM alone is ignored
      expect(results[1]?.exitCode).toBe(0);
      expect(logs[0]).toBe(
        `Upload of ${asset.name} failed on attempt 1 (timed out after 0.5s); retrying in 0s.`,
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test("surfaces gh's stderr for a failed attempt and retries it", async () => {
    const { directory, env } = await fakeGhOnPath();
    const { run, attempts } = deterministicRun(directory, env, ["fail"]);
    const { io, logs } = recordingIo(run);

    await uploadAssets("v1.0.0", [asset], io, {
      maxAttempts: 2,
      timeoutMs: 5_000,
      backoffMs: () => 0,
    });

    expect(attempts).toHaveLength(2);
    expect(logs[0]).toBe(
      `Upload of ${asset.name} failed on attempt 1 (exit 1: HTTP 500: Error saving asset); retrying in 0s.`,
    );
  });

  test("reads uploaded asset names from gh release view", async () => {
    const { directory, env } = await fakeGhOnPath();
    await writeFile(
      path.join(directory, "view.json"),
      JSON.stringify({
        assets: [
          { name: "install", state: "uploaded" },
          { name: "checksums.txt", state: "starter" },
        ],
      }),
    );
    const { io } = recordingIo(createSpawnRun(env));

    await expect(uploadedAssetNames("v1.0.0", io)).resolves.toEqual(["install"]);
  });

  test("runs as a command and uploads all 22 assets from the working directory", async () => {
    const { directory, env, calls } = await fakeGhOnPath();
    const workdir = path.join(directory, "work");
    await mkdir(path.join(workdir, "dist"), { recursive: true });
    for (const asset of releaseAssets("1.0.0")) {
      await writeFile(path.join(workdir, asset.path), asset.name);
    }
    const bunExecutable = Bun.which("bun");
    if (!bunExecutable) throw new Error("Bun executable not found");

    const child = Bun.spawn([bunExecutable, scriptPath, "upload", "--version", "1.0.0"], {
      cwd: workdir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(await calls()).toHaveLength(22);
    expect(stdout.trim().split("\n")).toHaveLength(22);
    expect(stdout).toContain("Uploaded install (attempt 1).");
  }, 20_000);
});
