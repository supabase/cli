import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocatedPorts } from "@supabase/stack";
import { createFleet } from "./Fleet.ts";
import { PodRegistry } from "./PodRegistry.ts";
import type { PodManifest } from "./PodManifest.ts";

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

// Manifest ports must sit in the fleet's public range (55000+), with the
// derived internal set (port - 10_000) inside the internal range (< 55000).
// The OS ephemeral range may sit entirely below 55000, so probe candidates
// in the fleet range directly instead of asking for port 0.
async function freeFleetPort(): Promise<number> {
  const start = 55000 + Math.floor(Math.random() * 8000);
  for (let offset = 0; offset < 200; offset += 1) {
    const candidate = start + offset;
    if (await tryListen(candidate)) return candidate;
  }
  throw new Error("could not find a free port in the fleet public range");
}

function expectPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });
}

function ports(dbPort: number, apiPort: number): AllocatedPorts {
  return {
    dbPort,
    apiPort,
    authPort: apiPort + 1,
    postgrestPort: apiPort + 2,
    postgrestAdminPort: apiPort + 3,
    edgeRuntimePort: apiPort + 4,
    edgeRuntimeInspectorPort: apiPort + 5,
    realtimePort: apiPort + 6,
    storagePort: apiPort + 7,
    imgproxyPort: apiPort + 8,
    mailpitPort: apiPort + 9,
    mailpitSmtpPort: apiPort + 10,
    mailpitPop3Port: apiPort + 11,
    pgmetaPort: apiPort + 12,
    studioPort: apiPort + 13,
    analyticsPort: apiPort + 14,
    poolerPort: apiPort + 15,
    poolerApiPort: apiPort + 16,
  };
}

function manifest(id: string, dbPort: number, apiPort: number): PodManifest {
  return {
    id,
    versions: { postgres: "17.6.1.143" },
    services: {},
    flags: { supautils: false },
    warm: false,
    ports: ports(dbPort, apiPort),
    internalPorts: ports(dbPort - 10_000, apiPort - 10_000),
    postgresPassword: "postgres",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

describe("createFleet", () => {
  it("closes registered edge listeners when startup reconciliation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      const pods = new PodRegistry(join(root, "pods"));
      const dbPort = await freeFleetPort();
      // Derived with a fixed offset (never bound by the test) so it can't
      // collide with dbPort's field range within the same manifest.
      const apiPort = dbPort + 100;

      await pods.write(manifest("pod-a", dbPort, apiPort));
      await pods.write(manifest("pod-b", dbPort, apiPort + 1));

      await expect(createFleet({ root })).rejects.toThrow(/port already assigned/);
      await expect(expectPortAvailable(dbPort)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
