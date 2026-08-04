import { describe, expect, it } from "@effect/vitest";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { acquireManagedPortLock, privateManagedLockPath } from "./ManagedPortLock.ts";

describe("ManagedPortLock", () => {
  it("serializes independent port allocators", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-"));
    const lockPath = join(root, "allocation.lock");

    try {
      const releaseFirst = await acquireManagedPortLock(lockPath);
      let secondAcquired = false;
      const second = acquireManagedPortLock(lockPath).then((release) => {
        secondAcquired = true;
        return release;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondAcquired).toBe(false);

      await releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      await releaseSecond();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a waiter without acquiring the lock later", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-abort-"));
    const lockPath = join(root, "allocation.lock");

    try {
      const releaseFirst = await acquireManagedPortLock(lockPath);
      const controller = new AbortController();
      const pending = acquireManagedPortLock(lockPath, controller.signal);
      const interrupted = expect(pending).rejects.toBeDefined();

      controller.abort();
      await interrupted;
      await releaseFirst();

      const releaseNext = await acquireManagedPortLock(lockPath);
      await releaseNext();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates lock generations that other users can remove", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-mode-"));
    const lockPath = join(root, "allocation.lock");

    try {
      const release = await acquireManagedPortLock(lockPath);
      if (process.platform !== "win32") {
        expect((await stat(lockPath)).mode & 0o777).toBe(0o777);
      }
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps state lock generations private to the current user", async () => {
    const lockPath = privateManagedLockPath(`test:${process.pid}:${Date.now()}`);
    const release = await acquireManagedPortLock(lockPath);
    try {
      if (process.platform !== "win32") {
        expect((await stat(dirname(lockPath))).mode & 0o777).toBe(0o700);
        expect((await stat(lockPath)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await release();
    }
  });

  it("keeps a legacy numeric owner held while its process is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-legacy-"));
    const lockPath = join(root, "allocation.lock");

    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), String(process.pid), "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      let acquired = false;
      const pending = acquireManagedPortLock(lockPath).then((release) => {
        acquired = true;
        return release;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(acquired).toBe(false);

      await rm(lockPath, { recursive: true, force: true });
      const release = await pending;
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a reused PID from a different process generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-generation-"));
    const lockPath = join(root, "allocation.lock");

    try {
      await mkdir(lockPath, { mode: 0o777 });
      await writeFile(
        join(lockPath, "owner"),
        JSON.stringify({
          pid: process.pid,
          bootMinute: Math.round((Date.now() - uptime() * 1_000) / 60_000),
          token: "abandoned",
          startIdentity: "different-process-generation",
        }),
        "utf8",
      );

      const release = await acquireManagedPortLock(lockPath);
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets only one allocator replace an abandoned lock generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-port-lock-stale-"));
    const lockPath = join(root, "allocation.lock");

    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), "invalid owner", "utf8");
      const staleTime = new Date(Date.now() - 10_000);
      await utimes(lockPath, staleTime, staleTime);

      let active = 0;
      let maxActive = 0;
      const first = acquireManagedPortLock(lockPath).then(async (release) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 75));
        active -= 1;
        await release();
      });
      const second = acquireManagedPortLock(lockPath).then(async (release) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
        await release();
      });

      await Promise.all([first, second]);
      expect(maxActive).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
