import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocatedPorts } from "@supabase/stack";
import { PortRegistry, type PodPorts } from "./PortRegistry.ts";

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

function podPorts(
  dbPort: number,
  apiPort: number,
  internalDbPort = dbPort - 10_000,
  internalApiPort = apiPort - 10_000,
): PodPorts {
  return {
    ports: ports(dbPort, apiPort),
    internalPorts: ports(internalDbPort, internalApiPort),
  };
}

describe("PortRegistry", () => {
  it("allocates unique port pairs and persists them", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);
    const a = await reg.allocate("pod-a");
    const b = await reg.allocate("pod-b");
    expect(new Set([a.ports.dbPort, a.ports.apiPort, b.ports.dbPort, b.ports.apiPort]).size).toBe(
      4,
    );
    expect(a.internalPorts.dbPort).toBe(45000);
    expect(a.internalPorts.apiPort).toBe(45001);

    const reloaded = await PortRegistry.load(file);
    expect(reloaded.get("pod-a")).toEqual(a);
    expect(reloaded.get("pod-b")).toEqual(b);
  });

  it("is idempotent per pod and reuses released ports", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);
    const a1 = await reg.allocate("pod-a");
    const a2 = await reg.allocate("pod-a");
    expect(a2).toEqual(a1);
    await reg.release("pod-a");
    expect(reg.get("pod-a")).toBeUndefined();
    const c = await reg.allocate("pod-c");
    expect(c.ports.dbPort).toBe(a1.ports.dbPort); // freed ports are reusable
    expect(c.internalPorts.dbPort).toBe(a1.internalPorts.dbPort);
  });

  it("treats inherited property names as ordinary pod ids", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);

    const ports = await reg.allocate("constructor");

    expect(ports.ports).toEqual(expect.objectContaining({ dbPort: 55000, apiPort: 55001 }));
    expect(ports.internalPorts).toEqual(expect.objectContaining({ dbPort: 45000, apiPort: 45001 }));
    expect(
      new Set([...Object.values(ports.ports), ...Object.values(ports.internalPorts)]).size,
    ).toBe(36);
    expect(reg.get("constructor")).toEqual(ports);
  });

  it("serializes concurrent mutations before persisting", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);

    const pods = Array.from({ length: 20 }, (_, index) => `pod-${index}`);
    await Promise.all(pods.map((pod) => reg.allocate(pod)));
    await Promise.all(pods.slice(0, 10).map((pod) => reg.release(pod)));
    await Promise.all(pods.slice(0, 10).map((pod) => reg.allocate(`${pod}-new`)));

    const reloaded = await PortRegistry.load(file);
    const restored = [...pods.slice(10), ...pods.slice(0, 10).map((pod) => `${pod}-new`)].map(
      (pod) => reloaded.get(pod),
    );
    expect(restored.every((ports) => ports !== undefined)).toBe(true);
  });

  it("quarantines a corrupt state file and loads with fresh empty state", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const garbage = "{not valid json at all";
    await writeFile(file, garbage);

    const reg = await PortRegistry.load(file);

    // Loads successfully with fresh empty state.
    expect(reg.get("anything")).toBeUndefined();
    const allocated = await reg.allocate("pod-a");
    expect(allocated.ports.dbPort).toBeGreaterThanOrEqual(55000);
    expect(allocated.internalPorts.dbPort).toBeGreaterThanOrEqual(45000);

    // Original bad bytes are preserved in the quarantine file.
    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(garbage);
  });

  it("quarantines a structurally invalid state file (bad basePort/pods)", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const badStructure = JSON.stringify({
      basePort: "not-a-number",
      internalBasePort: 45000,
      pods: [],
    });
    await writeFile(file, badStructure);

    const reg = await PortRegistry.load(file);
    expect(reg.get("anything")).toBeUndefined();
    const allocated = await reg.allocate("pod-a");
    expect(allocated.ports.dbPort).toBeGreaterThanOrEqual(55000);

    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(badStructure);
  });

  it("quarantines saved pod entries with invalid port records", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const badStructure = JSON.stringify({
      basePort: 55000,
      internalBasePort: 45000,
      pods: {
        "pod-a": podPorts(55010, 55011),
      },
    });
    const parsed = JSON.parse(badStructure);
    parsed.pods["pod-a"].ports.poolerApiPort = "55027";
    const raw = JSON.stringify(parsed);
    await writeFile(file, raw);

    const reg = await PortRegistry.load(file);
    expect(reg.get("pod-a")).toBeUndefined();
    const allocated = await reg.allocate("pod-a");
    expect(allocated.ports).toEqual(expect.objectContaining({ dbPort: 55000, apiPort: 55001 }));

    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(raw);
  });

  it("overwrites any previous quarantine file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    await writeFile(`${file}.corrupt`, "old-quarantine");
    const garbage = "{ still bad";
    await writeFile(file, garbage);

    await PortRegistry.load(file);

    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(garbage);
  });

  describe("restore", () => {
    it("records known allocations from pod manifests without scanning", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011));
      await reg.restore("pod-b", podPorts(55030, 55031, 45030, 45031));

      expect(reg.get("pod-a")?.ports).toEqual(
        expect.objectContaining({ dbPort: 55010, apiPort: 55011 }),
      );
      expect(reg.get("pod-a")?.internalPorts).toEqual(
        expect.objectContaining({ dbPort: 45010, apiPort: 45011 }),
      );
      expect(reg.get("pod-b")?.ports).toEqual(
        expect.objectContaining({ dbPort: 55030, apiPort: 55031 }),
      );

      // New allocations must skip the restored ports.
      const next = await reg.allocate("new-pod");
      expect([next.ports.dbPort, next.ports.apiPort]).not.toContain(55010);
      expect([next.ports.dbPort, next.ports.apiPort]).not.toContain(55011);
      expect([next.ports.dbPort, next.ports.apiPort]).not.toContain(55030);
      expect([next.ports.dbPort, next.ports.apiPort]).not.toContain(55031);
      expect([next.internalPorts.dbPort, next.internalPorts.apiPort]).not.toContain(45010);
      expect([next.internalPorts.dbPort, next.internalPorts.apiPort]).not.toContain(45011);

      // Persisted, so a reload sees the restored allocation.
      const reloaded = await PortRegistry.load(file);
      expect(reloaded.get("pod-a")?.ports).toEqual(
        expect.objectContaining({ dbPort: 55010, apiPort: 55011 }),
      );
    });

    it("is idempotent when restoring identical ports for the same pod", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011));
      await expect(
        reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011)),
      ).resolves.toBeUndefined();
      expect(reg.get("pod-a")?.ports).toEqual(
        expect.objectContaining({ dbPort: 55010, apiPort: 55011 }),
      );
    });

    it("throws if the pod already has different ports recorded", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011));
      await expect(reg.restore("pod-a", podPorts(55010, 55099, 45010, 45099))).rejects.toThrow();
    });

    it("throws if a port is already assigned to a different pod", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011));
      await expect(reg.restore("pod-b", podPorts(55010, 55030, 45030, 45031))).rejects.toThrow();
      await expect(reg.restore("pod-b", podPorts(55030, 55011, 45030, 45031))).rejects.toThrow();
      await expect(reg.restore("pod-b", podPorts(55030, 55031, 45010, 45030))).rejects.toThrow();
    });

    it("throws if a restored db port collides with another pod's api port", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", podPorts(55010, 55011, 45010, 45011));
      await expect(reg.restore("pod-b", podPorts(55011, 55030, 45030, 45031))).rejects.toThrow();
      await expect(reg.restore("pod-b", podPorts(55030, 55010, 45030, 45031))).rejects.toThrow();
    });

    it("keeps internal allocations out of the public proxy range", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      await writeFile(file, JSON.stringify({ basePort: 65000, internalBasePort: 45000, pods: {} }));
      const reg = await PortRegistry.load(file);

      const allocated = await reg.allocate("pod-high");

      expect(allocated.ports.dbPort).toBe(65000);
      expect(allocated.internalPorts.dbPort).toBe(45000);
      expect(Object.values(allocated.internalPorts).every((port) => port < 55000)).toBe(true);
    });
  });
});
