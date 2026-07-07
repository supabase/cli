import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapStalePostmaster } from "./reapStalePostmaster.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("reapStalePostmaster", () => {
  const dirs: string[] = [];
  const pidsToCleanUp: number[] = [];

  afterEach(async () => {
    for (const pid of pidsToCleanUp.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a live detached process group referenced by postmaster.pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reap-test-"));
    dirs.push(dir);

    const child = spawn("bash", ["-c", `exec -a "postgres -D ${dir}" sleep 60`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("failed to spawn dummy process");
    pidsToCleanUp.push(pid);

    await writeFile(join(dir, "postmaster.pid"), `${pid}\n${dir}\n1234567\n5432\n`);

    expect(isAlive(pid)).toBe(true);
    await reapStalePostmaster(dir);
    await waitUntil(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);
  }, 10_000);

  it("is a no-op when postmaster.pid is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reap-test-"));
    dirs.push(dir);
    await expect(reapStalePostmaster(dir)).resolves.toBeUndefined();
  });

  it("is a no-op when postmaster.pid contains garbage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reap-test-"));
    dirs.push(dir);
    await writeFile(join(dir, "postmaster.pid"), "not-a-pid\nnoise\n");
    await expect(reapStalePostmaster(dir)).resolves.toBeUndefined();
  });

  it("refuses to kill when the pid equals the current process pid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reap-test-"));
    dirs.push(dir);
    await writeFile(join(dir, "postmaster.pid"), `${process.pid}\n/some/data/dir\n`);
    await expect(reapStalePostmaster(dir)).resolves.toBeUndefined();
    // Sanity: we're still alive (obviously true, but documents intent).
    expect(isAlive(process.pid)).toBe(true);
  });

  it("refuses to kill a reused pid that is not this postmaster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reap-test-"));
    dirs.push(dir);

    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("failed to spawn dummy process");
    pidsToCleanUp.push(pid);

    await writeFile(join(dir, "postmaster.pid"), `${pid}\n${dir}\n1234567\n5432\n`);

    await reapStalePostmaster(dir);
    expect(isAlive(pid)).toBe(true);
  });
});
