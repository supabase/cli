import { createServer } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

// Manifest ports must sit in the fleet's public range (55000+). The OS
// ephemeral range may sit entirely below it, so probe candidates directly.
async function freeFleetPort(): Promise<number> {
  const start = 55000 + Math.floor(Math.random() * 8000);
  for (let offset = 0; offset < 200; offset += 1) {
    const candidate = start + offset;
    if ((await tryListen(candidate)) && (await tryListen(candidate + 1))) return candidate;
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

function manifest(id: string, dbPort: number): PodManifest {
  return {
    id,
    versions: { postgres: "17.6.1.143" },
    services: [],
    flags: { supautils: false },
    warm: false,
    dbPort,
    apiPort: dbPort + 1,
    postgresPassword: "postgres",
    jwtSecret: "01234567890123456789012345678901",
    publishableKey: "sb_publishable_test",
    secretKey: "sb_secret_test",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

describe("createFleet", () => {
  it("refuses to start a second daemon for the same fleet root", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      const fleet = await createFleet({ root });
      try {
        await expect(createFleet({ root })).rejects.toThrow(/already owns/);
      } finally {
        await fleet.dispose();
      }
      // Once the owner releases the lock, the root is startable again.
      const second = await createFleet({ root });
      await second.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a stale fleet lock left by a dead daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      // No live process has this pid (well above typical pid ranges).
      await writeFile(join(root, "fleet.lock"), "999999");
      const fleet = await createFleet({ root });
      await fleet.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the fleet lock when registry initialization fails", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    const stateFile = join(root, "fleet-state.json");
    try {
      await writeFile(stateFile, JSON.stringify({ pods: {} }));
      await chmod(stateFile, 0o000);
      await expect(createFleet({ root })).rejects.toThrow();

      await chmod(stateFile, 0o600);
      const fleet = await createFleet({ root });
      await fleet.dispose();
    } finally {
      await chmod(stateFile, 0o600).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects every operation after disposal releases the fleet lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      const fleet = await createFleet({ root });
      await fleet.dispose();

      await expect(fleet.listPods()).rejects.toThrow("fleet is disposed");
      await expect(fleet.wake("pod-a")).rejects.toThrow("fleet is disposed");
      await expect(fleet.suspend("pod-a")).rejects.toThrow("fleet is disposed");
      await expect(fleet.destroyPod("pod-a")).rejects.toThrow("fleet is disposed");
      await expect(fleet.resetPod("pod-a")).rejects.toThrow("fleet is disposed");
      await expect(fleet.forkPod("pod-a", "pod-b")).rejects.toThrow("fleet is disposed");
      await expect(fleet.ensureExtensionPreload("pod-a", "pg_cron")).rejects.toThrow(
        "fleet is disposed",
      );
      await expect(fleet.createPod({ id: "pod-a" })).rejects.toThrow("fleet is disposed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes registered edge listeners when startup reconciliation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
    try {
      const pods = new PodRegistry(join(root, "pods"));
      const dbPort = await freeFleetPort();
      await pods.write(manifest("pod-a", dbPort));
      await pods.write(manifest("pod-b", dbPort));

      await expect(createFleet({ root })).rejects.toThrow(/port already assigned/);
      await expect(expectPortAvailable(dbPort)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
