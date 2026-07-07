import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortRegistry } from "./PortRegistry.ts";

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
});
