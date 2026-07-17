import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquirePortLease } from "./PortLease.ts";

describe("PortLease", () => {
  it("keeps concurrent same-process allocations disjoint until release", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "stack-port-leases-"));
    try {
      const leases = await Promise.all(
        Array.from({ length: 4 }, () => acquirePortLease(cacheRoot, {})),
      );
      try {
        const ports = leases.flatMap((lease) => Object.values(lease.ports));
        expect(new Set(ports).size).toBe(ports.length);
      } finally {
        await Promise.all(leases.map((lease) => lease.release()));
      }
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("protects explicit ports and makes them available after release", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "stack-port-leases-"));
    const first = await acquirePortLease(cacheRoot, {});
    const apiPort = first.ports.apiPort;
    try {
      await expect(acquirePortLease(cacheRoot, { apiPort })).rejects.toThrow(
        `Port ${apiPort} is not available`,
      );
      await first.release();
      const second = await acquirePortLease(cacheRoot, { apiPort });
      expect(second.ports.apiPort).toBe(apiPort);
      await second.release();
    } finally {
      await first.release();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
