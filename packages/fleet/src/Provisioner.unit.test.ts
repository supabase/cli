import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VERSIONS, type ServiceName, type VersionManifest } from "@supabase/stack";
import { describe, expect, it } from "vitest";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner } from "./Provisioner.ts";
import type { TemplateStore } from "./TemplateStore.ts";

const PG_VERSION = "17.6.1.143";

/**
 * A minimal stand-in for `TemplateStore` that skips booting a real Postgres
 * stack: `ensureBaseTemplate`/`ensureWarmTemplate` just hand back a
 * pre-populated (or, for the failure tests, deliberately missing) directory.
 * Cast through `unknown` because `TemplateStore` has private members that a
 * structural object literal can never satisfy.
 */
function fakeTemplateStore(templateDir: string): TemplateStore {
  return {
    async ensureBaseTemplate(_postgresVersion: string): Promise<string> {
      return templateDir;
    },
    async ensureWarmTemplate(
      _versions: Partial<VersionManifest>,
      _enabledServices: ReadonlyArray<ServiceName>,
    ): Promise<string> {
      return templateDir;
    },
  } as unknown as TemplateStore;
}

async function makeHarness(templateDir: string) {
  const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
  const podsRoot = join(root, "pods");
  const pods = new PodRegistry(podsRoot);
  const ports = await PortRegistry.load(join(root, "fleet-state.json"));
  const templates = fakeTemplateStore(templateDir);
  return { p: new Provisioner({ templates, pods, ports }), pods, ports, podsRoot };
}

async function podsRootEntries(podsRoot: string): Promise<string[]> {
  return readdir(podsRoot).catch(() => [] as string[]);
}

describe("Provisioner (unit, fake deps)", () => {
  describe("create", () => {
    it("provisions a pod from a valid template", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, pods, ports } = await makeHarness(templateDir);

      const manifest = await p.create({ id: "x", versions: { postgres: PG_VERSION } });

      expect(manifest.id).toBe("x");
      expect(ports.get("x")).toEqual(manifest.ports);
      expect(await pods.read("x")).toEqual(manifest);
    });

    it("releases the allocated ports and cleans up when cloning fails", async () => {
      // Non-existent template dir => cloneDir's src stat/copy fails, throwing
      // before the manifest is ever written.
      const missingTemplateDir = join(await mkdtemp(join(tmpdir(), "fleet-template-")), "missing");
      const { p, ports, podsRoot } = await makeHarness(missingTemplateDir);

      await expect(p.create({ id: "x", versions: { postgres: PG_VERSION } })).rejects.toThrow();

      expect(ports.get("x")).toBeUndefined();
      expect(await podsRootEntries(podsRoot)).not.toContain("x");
    });

    it("does not release ports belonging to a pre-existing pod on the duplicate-id path", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports } = await makeHarness(templateDir);

      const first = await p.create({ id: "dup", versions: { postgres: PG_VERSION } });
      await expect(p.create({ id: "dup", versions: { postgres: PG_VERSION } })).rejects.toThrow(
        /exists/,
      );

      // The duplicate-id pre-check throws before any (re-)allocation, so the
      // original pod's ports must still be intact.
      expect(ports.get("dup")).toEqual(first.ports);
    });

    it("records resolved default versions for enabled warm services", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p } = await makeHarness(templateDir);

      const manifest = await p.create({
        id: "warm",
        versions: { postgres: PG_VERSION },
        services: { postgrest: true },
        warm: true,
      });

      expect(manifest.versions).toEqual({
        postgres: PG_VERSION,
        postgrest: DEFAULT_VERSIONS.postgrest,
      });
    });
  });

  describe("fork", () => {
    it("clones an existing pod into a new one", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, pods, ports } = await makeHarness(templateDir);

      const source = await p.create({ id: "src", versions: { postgres: PG_VERSION } });
      const forked = await p.fork("src", "dst");

      expect(forked.id).toBe("dst");
      expect(forked.ports).not.toEqual(source.ports);
      expect(ports.get("dst")).toEqual(forked.ports);
      expect(await pods.read("dst")).toEqual(forked);
    });

    it("releases the allocated ports and cleans up when the clone fails", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      await p.create({ id: "src", versions: { postgres: PG_VERSION } });

      // Force the fork's clone step to fail deterministically: cloneDir
      // refuses to clone into a destination that already exists.
      await mkdir(join(podsRoot, "dst", "data"), { recursive: true });

      await expect(p.fork("src", "dst")).rejects.toThrow();

      expect(ports.get("dst")).toBeUndefined();
      // The pre-created dest dir is removed as part of failure cleanup too.
      expect(await podsRootEntries(podsRoot)).toContain("src");
      const dstDataEntries = await readdir(join(podsRoot, "dst", "data")).catch(() => undefined);
      expect(dstDataEntries).toBeUndefined();
    });

    it("does not release the source pod's ports when the new id already exists", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports } = await makeHarness(templateDir);

      const source = await p.create({ id: "src", versions: { postgres: PG_VERSION } });
      const existing = await p.create({ id: "dst", versions: { postgres: PG_VERSION } });

      await expect(p.fork("src", "dst")).rejects.toThrow(/exists/);

      // The pre-check for an already-existing target throws before
      // (re-)allocating, so neither pod's ports should be disturbed.
      expect(ports.get("src")).toEqual(source.ports);
      expect(ports.get("dst")).toEqual(existing.ports);
    });
  });
});
