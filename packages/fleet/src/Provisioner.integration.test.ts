import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner } from "./Provisioner.ts";
import { TemplateStore } from "./TemplateStore.ts";

const PG_VERSION = "17.6.1.143";

describe.skipIf(!process.env.FLEET_PG_TESTS)("Provisioner", () => {
  async function makeProvisioner() {
    const root = await mkdtemp(join(tmpdir(), "fleet-"));
    const templates = new TemplateStore(join(root, "templates"));
    const pods = new PodRegistry(join(root, "pods"));
    const ports = await PortRegistry.load(join(root, "fleet-state.json"));
    return { p: new Provisioner({ templates, pods, ports, postgresPassword: "postgres" }), pods };
  }

  it("creates, forks, resets, destroys", async () => {
    const { p, pods } = await makeProvisioner();
    const a = await p.create({ id: "a", versions: { postgres: PG_VERSION } });
    expect(a.ports.dbPort).toBeGreaterThan(0);
    expect(await stat(join(pods.dataDir("a"), "PG_VERSION")).then(() => true)).toBe(true);

    // fork: divergence
    await writeFile(join(pods.dataDir("a"), "marker.txt"), "from-a");
    const b = await p.fork("a", "b");
    expect(b.ports.dbPort).not.toBe(a.ports.dbPort);
    await writeFile(join(pods.dataDir("b"), "marker.txt"), "from-b");
    expect(await readFile(join(pods.dataDir("a"), "marker.txt"), "utf8")).toBe("from-a");

    // reset: marker disappears (re-cloned from template)
    await p.reset("a");
    expect(
      await stat(join(pods.dataDir("a"), "marker.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    await p.destroy("a");
    await p.destroy("b");
    expect(await pods.list()).toEqual([]);
  }, 300_000);

  it("rejects duplicate ids", async () => {
    const { p } = await makeProvisioner();
    await p.create({ id: "dup", versions: { postgres: PG_VERSION } });
    await expect(p.create({ id: "dup", versions: { postgres: PG_VERSION } })).rejects.toThrow(
      /exists/,
    );
  }, 300_000);
});
