import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VERSIONS, type ServiceName, type VersionManifest } from "@supabase/stack";
import { describe, expect, it } from "vitest";
import { PodRegistry } from "./PodRegistry.ts";
import { PortRegistry } from "./PortRegistry.ts";
import { Provisioner, type CreatePodOptions } from "./Provisioner.ts";
import type { TemplateStore } from "./TemplateStore.ts";

const PG_VERSION = "17.6.1.143";

/**
 * A minimal stand-in for `TemplateStore` that skips booting a real Postgres
 * stack: `ensureBaseTemplate`/`ensureWarmTemplate` just hand back a
 * pre-populated (or, for the failure tests, deliberately missing) directory.
 * Cast through `unknown` because `TemplateStore` has private members that a
 * structural object literal can never satisfy.
 */
function fakeTemplateStore(templateDir: string, calls: string[]): TemplateStore {
  return {
    async ensureBaseTemplate(_postgresVersion: string): Promise<string> {
      calls.push("base");
      return templateDir;
    },
    async ensureWarmTemplate(
      _versions: Partial<VersionManifest>,
      enabledServices: ReadonlyArray<ServiceName>,
    ): Promise<string> {
      calls.push(`warm:${[...enabledServices].sort().join(",")}`);
      return templateDir;
    },
  } as unknown as TemplateStore;
}

async function makeHarness(templateDir: string) {
  const root = await mkdtemp(join(tmpdir(), "fleet-unit-"));
  const podsRoot = join(root, "pods");
  const pods = new PodRegistry(podsRoot);
  const ports = await PortRegistry.load(join(root, "fleet-state.json"));
  const templateCalls: string[] = [];
  const templates = fakeTemplateStore(templateDir, templateCalls);
  return {
    p: new Provisioner({ templates, pods, ports, postgresPassword: "secret-password" }),
    pods,
    ports,
    podsRoot,
    templateCalls,
  };
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
      expect(manifest.postgresPassword).toBe("secret-password");
      expect(ports.get("x")).toEqual({
        ports: manifest.ports,
        internalPorts: manifest.internalPorts,
      });
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

    it("refuses to create over a corrupt pod directory without deleting it", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      // A leftover pod dir whose manifest no longer parses: read() sees
      // nothing, but the data underneath must survive a create attempt.
      await mkdir(join(podsRoot, "zombie", "data"), { recursive: true });
      await writeFile(join(podsRoot, "zombie", "pod.json"), "not-json");
      await writeFile(join(podsRoot, "zombie", "data", "keep.txt"), "keep");

      await expect(p.create({ id: "zombie", versions: { postgres: PG_VERSION } })).rejects.toThrow(
        /exists/,
      );

      expect(ports.get("zombie")).toBeUndefined();
      await expect(readFile(join(podsRoot, "zombie", "data", "keep.txt"), "utf8")).resolves.toBe(
        "keep",
      );
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
      expect(ports.get("dup")).toEqual({
        ports: first.ports,
        internalPorts: first.internalPorts,
      });
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

    it("rejects invalid service dependency combinations before provisioning", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      await expect(
        p.create({
          id: "bad",
          versions: { postgres: PG_VERSION },
          services: { imgproxy: true },
        }),
      ).rejects.toThrow(/imgproxy requires storage/);

      expect(ports.get("bad")).toBeUndefined();
      expect(await podsRootEntries(podsRoot)).not.toContain("bad");
    });

    it("rejects unknown or non-boolean service entries before provisioning", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      // Simulates an untyped JS caller: persisting "postrest" would make the
      // registry's strict parser reject the whole manifest on the next read.
      const junkServices = { postrest: true } as unknown as CreatePodOptions["services"];
      await expect(
        p.create({ id: "bad", versions: { postgres: PG_VERSION }, services: junkServices }),
      ).rejects.toThrow(/invalid service entry/);

      expect(ports.get("bad")).toBeUndefined();
      expect(await podsRootEntries(podsRoot)).not.toContain("bad");
    });

    it("rejects services that cannot run in native fleet mode before provisioning", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      await expect(
        p.create({
          id: "bad",
          versions: { postgres: PG_VERSION },
          services: { storage: true },
        }),
      ).rejects.toThrow(/native mode/);

      expect(ports.get("bad")).toBeUndefined();
      expect(await podsRootEntries(podsRoot)).not.toContain("bad");
    });
  });

  describe("reset", () => {
    it("re-clones the warm template for warm-created pods", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, templateCalls } = await makeHarness(templateDir);

      await p.create({
        id: "warm",
        versions: { postgres: PG_VERSION },
        services: { postgrest: true, auth: true },
        warm: true,
      });
      await p.reset("warm");

      expect(templateCalls.at(-1)).toBe("warm:auth,postgrest");
    });

    it("re-clones the base template for cold-created pods with enabled services", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, templateCalls } = await makeHarness(templateDir);

      await p.create({
        id: "cold",
        versions: { postgres: PG_VERSION },
        services: { postgrest: true },
      });
      await p.reset("cold");

      expect(templateCalls.at(-1)).toBe("base");
    });

    it("keeps the live data dir when cloning the replacement template fails", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, pods } = await makeHarness(templateDir);

      await p.create({ id: "x", versions: { postgres: PG_VERSION } });
      await writeFile(join(pods.dataDir("x"), "marker.txt"), "still-here");
      await rm(templateDir, { recursive: true, force: true });

      await expect(p.reset("x")).rejects.toThrow();

      await expect(readFile(join(pods.dataDir("x"), "marker.txt"), "utf8")).resolves.toBe(
        "still-here",
      );
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
      expect(forked.internalPorts).not.toEqual(source.internalPorts);
      expect(ports.get("dst")).toEqual({
        ports: forked.ports,
        internalPorts: forked.internalPorts,
      });
      expect(await pods.read("dst")).toEqual(forked);
    });

    it("releases the allocated ports and cleans up when the clone fails", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, pods, ports, podsRoot } = await makeHarness(templateDir);

      await p.create({ id: "src", versions: { postgres: PG_VERSION } });

      // Force the fork's clone step to fail deterministically: delete the
      // source data dir out from under it.
      await rm(pods.dataDir("src"), { recursive: true, force: true });

      await expect(p.fork("src", "dst")).rejects.toThrow();

      expect(ports.get("dst")).toBeUndefined();
      expect(await podsRootEntries(podsRoot)).toContain("src");
      expect(await podsRootEntries(podsRoot)).not.toContain("dst");
    });

    it("refuses to fork onto an existing pod directory without deleting it", async () => {
      const templateDir = await mkdtemp(join(tmpdir(), "fleet-template-"));
      await writeFile(join(templateDir, "PG_VERSION"), PG_VERSION);
      const { p, ports, podsRoot } = await makeHarness(templateDir);

      await p.create({ id: "src", versions: { postgres: PG_VERSION } });
      // An occupied directory whose manifest is unreadable still counts.
      await mkdir(join(podsRoot, "dst", "data"), { recursive: true });
      await writeFile(join(podsRoot, "dst", "data", "keep.txt"), "keep");

      await expect(p.fork("src", "dst")).rejects.toThrow(/exists/);

      expect(ports.get("dst")).toBeUndefined();
      await expect(readFile(join(podsRoot, "dst", "data", "keep.txt"), "utf8")).resolves.toBe(
        "keep",
      );
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
      expect(ports.get("src")).toEqual({
        ports: source.ports,
        internalPorts: source.internalPorts,
      });
      expect(ports.get("dst")).toEqual({
        ports: existing.ports,
        internalPorts: existing.internalPorts,
      });
    });
  });
});
