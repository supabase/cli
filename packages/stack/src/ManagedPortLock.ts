import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";

const LOCK_STALE_AFTER_MS = 5_000;
const LOCK_RETRY_AFTER_MS = 25;
const SHARED_LOCK_ROOT = join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  "supabase-stack-managed-port-locks",
);
const DEFAULT_LOCK_PATH = join(SHARED_LOCK_ROOT, "allocation.lock");

interface LockOwner {
  readonly pid: number;
  readonly bootMinute: number;
  readonly token: string;
  readonly startIdentity?: string;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const currentBootMinute = (): number => Math.round((Date.now() - uptime() * 1_000) / 60_000);

const processStartIdentity = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = processStat
        .slice(processStat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      return startTicks === undefined ? undefined : `linux:${startTicks}`;
    }
    if (process.platform === "win32") {
      const ticks = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
      ).trim();
      return ticks.length === 0 ? undefined : `win32:${ticks}`;
    }
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return started.length === 0 ? undefined : `${process.platform}:${started}`;
  } catch {
    return undefined;
  }
};

const parseOwner = (contents: string): LockOwner | undefined => {
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return { pid: value, bootMinute: currentBootMinute(), token: "legacy" };
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "bootMinute" in value &&
      typeof value.bootMinute === "number" &&
      Number.isSafeInteger(value.bootMinute) &&
      "token" in value &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      (!("startIdentity" in value) || typeof value.startIdentity === "string")
    ) {
      const startIdentity =
        "startIdentity" in value && typeof value.startIdentity === "string"
          ? value.startIdentity
          : undefined;
      return {
        pid: value.pid,
        bootMinute: value.bootMinute,
        token: value.token,
        ...(startIdentity === undefined ? {} : { startIdentity }),
      };
    }
  } catch {
    // Older lock owners wrote only their PID. They remain readable during upgrades.
    const pid = Number(contents.trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { pid, bootMinute: currentBootMinute(), token: "legacy" };
    }
  }
  return undefined;
};

const readOwnerContents = async (lockPath: string): Promise<string | undefined> => {
  try {
    return await readFile(join(lockPath, "owner"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
};

const ownerIsActive = (contents: string): boolean => {
  const owner = parseOwner(contents);
  return (
    owner !== undefined &&
    Math.abs(owner.bootMinute - currentBootMinute()) <= 2 &&
    processIsAlive(owner.pid) &&
    (owner.startIdentity === undefined || processStartIdentity(owner.pid) === owner.startIdentity)
  );
};

const shouldReclaimLock = async (
  lockPath: string,
): Promise<{ readonly ownerContents: string | undefined; readonly stale: boolean }> => {
  const ownerContents = await readOwnerContents(lockPath);
  if (ownerContents !== undefined) {
    return { ownerContents, stale: !ownerIsActive(ownerContents) };
  }

  try {
    const info = await stat(lockPath);
    return {
      ownerContents,
      stale: Date.now() - info.mtime.getTime() >= LOCK_STALE_AFTER_MS,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ownerContents, stale: false };
    throw error;
  }
};

const moveLockGeneration = async (
  lockPath: string,
  expectedOwner: string | undefined,
): Promise<string | undefined> => {
  const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }

  const movedOwner = await readOwnerContents(quarantinePath);
  if (movedOwner === expectedOwner) return quarantinePath;

  try {
    await rename(quarantinePath, lockPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
  }
  return undefined;
};

const reclaimLock = async (lockPath: string, expectedOwner: string | undefined): Promise<void> => {
  const quarantinePath = await moveLockGeneration(lockPath, expectedOwner);
  if (quarantinePath !== undefined) {
    await rm(quarantinePath, { recursive: true, force: true });
  }
};

const prepareSharedLockRoot = async (): Promise<void> => {
  if (process.platform === "win32") {
    await mkdir(SHARED_LOCK_ROOT, { recursive: true });
    return;
  }

  for (let attempt = 0; attempt < 200; attempt++) {
    await mkdir(SHARED_LOCK_ROOT, { recursive: true, mode: 0o777 });
    try {
      await chmod(SHARED_LOCK_ROOT, 0o777);
    } catch (error) {
      if (errorCode(error) !== "EPERM" && errorCode(error) !== "EACCES") throw error;
    }
    const info = await stat(SHARED_LOCK_ROOT);
    if ((info.mode & 0o007) === 0o007) return;
    await delay(LOCK_RETRY_AFTER_MS);
  }
  throw new Error(`Shared managed-port lock directory is not writable: ${SHARED_LOCK_ROOT}`);
};

export type ReleaseManagedPortLock = () => Promise<void>;

/** Serialize port selection and lease handoff across foreground and detached stacks. */
export async function acquireManagedPortLock(
  lockPath = DEFAULT_LOCK_PATH,
): Promise<ReleaseManagedPortLock> {
  if (lockPath === DEFAULT_LOCK_PATH) {
    await prepareSharedLockRoot();
  }
  for (;;) {
    const startIdentity = processStartIdentity(process.pid);
    const ownerContents = JSON.stringify({
      pid: process.pid,
      bootMinute: currentBootMinute(),
      token: randomUUID(),
      ...(startIdentity === undefined ? {} : { startIdentity }),
    } satisfies LockOwner);

    try {
      await mkdir(lockPath, { mode: 0o777 });
      try {
        if (process.platform !== "win32") {
          // The shared generation must remain removable by a different user.
          // mkdir applies the process umask, so make the effective mode explicit.
          await chmod(lockPath, 0o777);
        }
        await writeFile(join(lockPath, "owner"), ownerContents, "utf8");
        if ((await readOwnerContents(lockPath)) !== ownerContents) continue;
      } catch (error) {
        const quarantinePath = await moveLockGeneration(lockPath, ownerContents);
        if (quarantinePath !== undefined) {
          await rm(quarantinePath, { recursive: true, force: true });
        }
        throw error;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const quarantinePath = await moveLockGeneration(lockPath, ownerContents);
        if (quarantinePath !== undefined) {
          await rm(quarantinePath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const observed = await shouldReclaimLock(lockPath);
    if (observed.stale) {
      await reclaimLock(lockPath, observed.ownerContents);
      continue;
    }
    await delay(LOCK_RETRY_AFTER_MS);
  }
}
