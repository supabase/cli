import { type AddressInfo, createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocatedPorts } from "@supabase/stack";
import { createFleet } from "./Fleet.ts";
import { PodRegistry } from "./PodRegistry.ts";
import type { PodManifest } from "./PodManifest.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
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
    ports: ports(dbPort, apiPort),
    postgresPassword: "postgres",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

describe("createFleet", () => {
  it("closes registered edge listeners when startup reconciliation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      const pods = new PodRegistry(join(root, "pods"));
      const dbPort = await freePort();
      const apiPort = await freePort();

      await pods.write(manifest("pod-a", dbPort, apiPort));
      await pods.write(manifest("pod-b", dbPort, apiPort + 1));

      await expect(createFleet({ root })).rejects.toThrow(/port already assigned/);
      await expect(expectPortAvailable(dbPort)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
