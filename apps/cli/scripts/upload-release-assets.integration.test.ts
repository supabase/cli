import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSpawnRun,
  releaseAssets,
  uploadAssets,
  uploadedAssetNames,
  type ReleaseIo,
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

// A stand-in `gh` that logs every call, fails or hangs once per marker file, and serves
// `release view` from view.json.
const fakeGh = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$*" >> "$dir/calls.log"
if [ "$1 $2" = "release view" ]; then
  cat "$dir/view.json"
  exit 0
fi
name="$(basename "$4")"
if [ -f "$dir/fail-once-$name" ]; then
  rm "$dir/fail-once-$name"
  echo "HTTP 500: Error saving asset" >&2
  exit 1
fi
if [ -f "$dir/hang-once-$name" ]; then
  rm "$dir/hang-once-$name"
  exec sleep 30
fi
exit 0
`;

async function fakeGhOnPath() {
  const directory = await mkdtemp(path.join(tmpdir(), "upload-release-assets-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), fakeGh);
  await chmod(path.join(bin, "gh"), 0o755);
  const env = { ...process.env, FAKE_GH_DIR: directory, PATH: `${bin}:${process.env.PATH}` };
  const calls = async () =>
    (await readFile(path.join(directory, "calls.log"), "utf8")).trimEnd().split("\n");
  return { directory, env, calls };
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
    const { directory, env, calls } = await fakeGhOnPath();
    await writeFile(path.join(directory, `hang-once-${asset.name}`), "");
    const { io, logs } = recordingIo(createSpawnRun(env));
    const startedAt = Date.now();

    await uploadAssets("v1.0.0", [asset], io, {
      maxAttempts: 2,
      timeoutMs: 500,
      backoffMs: () => 0,
    });

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await calls()).toEqual([
      `release upload v1.0.0 ${asset.path} --clobber`,
      `release upload v1.0.0 ${asset.path} --clobber`,
    ]);
    expect(logs).toEqual([
      `Upload of ${asset.name} failed on attempt 1 (timed out after 0.5s); retrying in 0s.`,
      `Uploaded ${asset.name} (attempt 2).`,
    ]);
  }, 20_000);

  test("surfaces gh's stderr for a failed attempt and retries it", async () => {
    const { directory, env, calls } = await fakeGhOnPath();
    await writeFile(path.join(directory, `fail-once-${asset.name}`), "");
    const { io, logs } = recordingIo(createSpawnRun(env));

    await uploadAssets("v1.0.0", [asset], io, {
      maxAttempts: 2,
      timeoutMs: 5_000,
      backoffMs: () => 0,
    });

    expect(await calls()).toHaveLength(2);
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
