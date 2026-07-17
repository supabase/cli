import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  allocatePorts,
  type AllocatedPorts,
  PortAllocationError,
  type PortInput,
} from "./PortAllocator.ts";

interface LeaseRecord {
  readonly pid: number;
  readonly ports: ReadonlyArray<number>;
}

interface LeaseState {
  readonly leases: Readonly<Record<string, LeaseRecord>>;
}

export interface PortLease {
  readonly ports: AllocatedPorts;
  release(): Promise<void>;
}

interface AcquirePortLeaseOptions {
  readonly preferred?: Partial<AllocatedPorts>;
  readonly reserved?: ReadonlySet<number>;
}

const LOCK_RETRY_MS = 10;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function parseState(raw: string): LeaseState {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("leases" in value)) {
    throw new Error("Invalid Stack port lease state");
  }
  const leases = value.leases;
  if (typeof leases !== "object" || leases === null || Array.isArray(leases)) {
    throw new Error("Invalid Stack port lease state");
  }
  const parsed: Record<string, LeaseRecord> = {};
  for (const [id, record] of Object.entries(leases)) {
    if (
      typeof record !== "object" ||
      record === null ||
      !("pid" in record) ||
      !("ports" in record) ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      !Array.isArray(record.ports) ||
      !record.ports.every(
        (port: unknown) =>
          typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535,
      )
    ) {
      throw new Error("Invalid Stack port lease state");
    }
    parsed[id] = { pid: record.pid, ports: record.ports };
  }
  return { leases: parsed };
}

async function readState(stateFile: string): Promise<LeaseState> {
  const raw = await readFile(stateFile, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  return raw === undefined ? { leases: {} } : parseState(raw);
}

async function writeState(stateFile: string, state: LeaseState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempFile, JSON.stringify(state));
    await rename(tempFile, stateFile);
  } catch (error) {
    const cleanup = await Promise.allSettled([unlink(tempFile)]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" && errorCode(result.reason) !== "ENOENT" ? [result.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Failed to persist and clean up Stack port lease state",
      );
    }
    throw error;
  }
}

type LockBodyResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly error: unknown };

async function withStateLock<T>(stateFile: string, body: () => Promise<T>): Promise<T> {
  const lockFile = `${stateFile}.lock`;
  await mkdir(dirname(stateFile), { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      let result: LockBodyResult<T>;
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        result = { _tag: "Success", value: await body() };
      } catch (error) {
        result = { _tag: "Failure", error };
      }
      const cleanup = [
        ...(await Promise.allSettled([handle.close()])),
        ...(await Promise.allSettled([unlink(lockFile)])),
      ];
      const cleanupErrors = cleanup.flatMap((outcome) =>
        outcome.status === "rejected" && errorCode(outcome.reason) !== "ENOENT"
          ? [outcome.reason]
          : [],
      );
      if (result._tag === "Failure") {
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [result.error, ...cleanupErrors],
            "Failed to use and release Stack port lease lock",
          );
        }
        throw result.error;
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Failed to release Stack port lease lock");
      }
      return result.value;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const owner: unknown = await readFile(lockFile, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => undefined);
      const stale =
        !isRecord(owner) ||
        typeof owner.pid !== "number" ||
        typeof owner.createdAt !== "number" ||
        !isProcessAlive(owner.pid);
      if (stale) {
        await unlink(lockFile).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

export async function acquirePortLease(
  cacheRoot: string,
  input: PortInput,
  options: AcquirePortLeaseOptions = {},
): Promise<PortLease> {
  const stateFile = join(cacheRoot, "runtime", "port-leases.json");
  const leaseId = randomUUID();
  const ports = await withStateLock(stateFile, async () => {
    const state = await readState(stateFile);
    const liveLeases = Object.fromEntries(
      Object.entries(state.leases).filter(([, lease]) => isProcessAlive(lease.pid)),
    );
    const leasedPorts = new Set<number>(options.reserved ?? []);
    for (const lease of Object.values(liveLeases)) {
      for (const port of lease.ports) leasedPorts.add(port);
    }
    const allocated = await Effect.runPromise(
      allocatePorts(input, { preferred: options.preferred, reserved: leasedPorts }),
    ).catch((error: unknown) => {
      if (error instanceof PortAllocationError) {
        throw new Error(error.detail, { cause: error });
      }
      throw error;
    });
    await writeState(stateFile, {
      leases: {
        ...liveLeases,
        [leaseId]: { pid: process.pid, ports: Object.values(allocated) },
      },
    });
    return allocated;
  });

  let released = false;
  return {
    ports,
    async release() {
      if (released) return;
      await withStateLock(stateFile, async () => {
        const state = await readState(stateFile);
        const leases = { ...state.leases };
        delete leases[leaseId];
        await writeState(stateFile, { leases });
      });
      released = true;
    },
  };
}
