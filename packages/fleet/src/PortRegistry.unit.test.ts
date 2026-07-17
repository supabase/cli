import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortRegistry } from "./PortRegistry.ts";

describe("PortRegistry", () => {
  it("allocates one stable endpoint per pod and persists it", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const registry = await PortRegistry.load(file);

    const a = await registry.allocate("pod-a");
    const b = await registry.allocate("pod-b");

    expect(a.dbPort).not.toBe(b.dbPort);
    expect(a.dbPort).toBeGreaterThanOrEqual(55_000);
    const reloaded = await PortRegistry.load(file);
    expect(reloaded.get("pod-a")).toEqual(a);
    expect(reloaded.get("pod-b")).toEqual(b);
  });

  it("is idempotent per pod and reuses released endpoints", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const registry = await PortRegistry.load(file);
    const first = await registry.allocate("pod-a");

    await expect(registry.allocate("pod-a")).resolves.toEqual(first);
    await registry.release("pod-a");
    await expect(registry.allocate("pod-b")).resolves.toEqual(first);
  });

  it("treats inherited property names as ordinary pod ids", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const registry = await PortRegistry.load(file);

    const endpoint = await registry.allocate("constructor");

    expect(registry.get("constructor")).toEqual(endpoint);
  });

  it("serializes concurrent mutations before persisting", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const registry = await PortRegistry.load(file);
    const ids = Array.from({ length: 20 }, (_, index) => `pod-${index}`);

    const endpoints = await Promise.all(ids.map((id) => registry.allocate(id)));

    expect(new Set(endpoints.map((endpoint) => endpoint.dbPort)).size).toBe(ids.length);
    const reloaded = await PortRegistry.load(file);
    expect(ids.every((id) => reloaded.get(id) !== undefined)).toBe(true);
  });

  it("skips a fleet port already owned by another host process", async () => {
    const server = createServer();
    const occupied = await new Promise<Server | undefined>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(undefined);
        else reject(error);
      });
      server.listen(55_000, "127.0.0.1", () => resolve(server));
    });
    try {
      const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
      const registry = await PortRegistry.load(file);
      const endpoint = await registry.allocate("pod-a");
      expect(endpoint.dbPort).not.toBe(55_000);
    } finally {
      await new Promise<void>((resolve) => {
        if (occupied === undefined) resolve();
        else occupied.close(() => resolve());
      });
    }
  });

  it("quarantines corrupt or structurally invalid state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ports-"));
    const invalidJson = join(root, "invalid-json.json");
    await writeFile(invalidJson, "{not json");
    const fromInvalidJson = await PortRegistry.load(invalidJson);
    expect(fromInvalidJson.get("pod-a")).toBeUndefined();
    await expect(readFile(`${invalidJson}.corrupt`, "utf8")).resolves.toBe("{not json");

    const duplicate = join(root, "duplicate.json");
    await writeFile(
      duplicate,
      JSON.stringify({ pods: { "pod-a": { dbPort: 55_010 }, "pod-b": { dbPort: 55_010 } } }),
    );
    const fromDuplicate = await PortRegistry.load(duplicate);
    expect(fromDuplicate.get("pod-a")).toBeUndefined();

    const wrongRange = join(root, "wrong-range.json");
    await writeFile(wrongRange, JSON.stringify({ pods: { "pod-a": { dbPort: 45_000 } } }));
    const fromWrongRange = await PortRegistry.load(wrongRange);
    expect(fromWrongRange.get("pod-a")).toBeUndefined();
  });

  it("validates manifest endpoints during reconciliation", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "ports-")), "state.json");
    const registry = await PortRegistry.load(file);

    await registry.reconcile(
      new Map([
        ["pod-a", { dbPort: 55_010 }],
        ["pod-b", { dbPort: 55_011 }],
      ]),
    );
    expect(registry.get("pod-a")).toEqual({ dbPort: 55_010 });
    await expect(
      registry.reconcile(
        new Map([
          ["pod-a", { dbPort: 55_010 }],
          ["pod-b", { dbPort: 55_010 }],
        ]),
      ),
    ).rejects.toThrow("already assigned");
    await expect(registry.reconcile(new Map([["pod-a", { dbPort: 45_000 }]]))).rejects.toThrow(
      "invalid endpoint",
    );
  });

  it("propagates state-file read errors instead of treating them as missing", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = await mkdtemp(join(tmpdir(), "ports-"));
    const file = join(root, "state.json");
    await writeFile(file, JSON.stringify({ pods: {} }));
    try {
      await chmod(root, 0o000);
      await expect(PortRegistry.load(file)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
    }
  });
});
