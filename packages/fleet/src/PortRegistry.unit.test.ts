import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AllocatedPorts } from "@supabase/stack";
import { PortRegistry } from "./PortRegistry.ts";

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

describe("PortRegistry", () => {
  it("allocates unique port pairs and persists them", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);
    const a = await reg.allocate("pod-a");
    const b = await reg.allocate("pod-b");
    expect(new Set([a.dbPort, a.apiPort, b.dbPort, b.apiPort]).size).toBe(4);

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
    expect(c.dbPort).toBe(a1.dbPort); // freed ports are reusable
  });

  it("treats inherited property names as ordinary pod ids", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const reg = await PortRegistry.load(file);

    const ports = await reg.allocate("constructor");

    expect(ports).toEqual(expect.objectContaining({ dbPort: 55000, apiPort: 55001 }));
    expect(new Set(Object.values(ports)).size).toBe(18);
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
    expect(allocated.dbPort).toBeGreaterThanOrEqual(55000);

    // Original bad bytes are preserved in the quarantine file.
    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(garbage);
  });

  it("quarantines a structurally invalid state file (bad basePort/pods)", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const badStructure = JSON.stringify({ basePort: "not-a-number", pods: [] });
    await writeFile(file, badStructure);

    const reg = await PortRegistry.load(file);
    expect(reg.get("anything")).toBeUndefined();
    const allocated = await reg.allocate("pod-a");
    expect(allocated.dbPort).toBeGreaterThanOrEqual(55000);

    const quarantined = await readFile(`${file}.corrupt`, "utf8");
    expect(quarantined).toBe(badStructure);
  });

  it("quarantines saved pod entries with invalid port records", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const badStructure = JSON.stringify({
      basePort: 55000,
      pods: {
        "pod-a": ports(55010, 55011),
      },
    });
    const parsed = JSON.parse(badStructure);
    parsed.pods["pod-a"].poolerApiPort = "55027";
    const raw = JSON.stringify(parsed);
    await writeFile(file, raw);

    const reg = await PortRegistry.load(file);
    expect(reg.get("pod-a")).toBeUndefined();
    const allocated = await reg.allocate("pod-a");
    expect(allocated).toEqual(expect.objectContaining({ dbPort: 55000, apiPort: 55001 }));

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

      await reg.restore("pod-a", ports(55010, 55011));
      await reg.restore("pod-b", ports(55030, 55031));

      expect(reg.get("pod-a")).toEqual(expect.objectContaining({ dbPort: 55010, apiPort: 55011 }));
      expect(reg.get("pod-b")).toEqual(expect.objectContaining({ dbPort: 55030, apiPort: 55031 }));

      // New allocations must skip the restored ports.
      const next = await reg.allocate("new-pod");
      expect([next.dbPort, next.apiPort]).not.toContain(55010);
      expect([next.dbPort, next.apiPort]).not.toContain(55011);
      expect([next.dbPort, next.apiPort]).not.toContain(55030);
      expect([next.dbPort, next.apiPort]).not.toContain(55031);

      // Persisted, so a reload sees the restored allocation.
      const reloaded = await PortRegistry.load(file);
      expect(reloaded.get("pod-a")).toEqual(
        expect.objectContaining({ dbPort: 55010, apiPort: 55011 }),
      );
    });

    it("is idempotent when restoring identical ports for the same pod", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", ports(55010, 55011));
      await expect(reg.restore("pod-a", ports(55010, 55011))).resolves.toBeUndefined();
      expect(reg.get("pod-a")).toEqual(expect.objectContaining({ dbPort: 55010, apiPort: 55011 }));
    });

    it("throws if the pod already has different ports recorded", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", ports(55010, 55011));
      await expect(reg.restore("pod-a", ports(55010, 55099))).rejects.toThrow();
    });

    it("throws if a port is already assigned to a different pod", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", ports(55010, 55011));
      await expect(reg.restore("pod-b", ports(55010, 55030))).rejects.toThrow();
      await expect(reg.restore("pod-b", ports(55030, 55011))).rejects.toThrow();
    });

    it("throws if a restored db port collides with another pod's api port", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const reg = await PortRegistry.load(file);

      await reg.restore("pod-a", ports(55010, 55011));
      await expect(reg.restore("pod-b", ports(55011, 55030))).rejects.toThrow();
      await expect(reg.restore("pod-b", ports(55030, 55010))).rejects.toThrow();
    });
  });
});
