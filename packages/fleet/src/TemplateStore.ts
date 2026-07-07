import { mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStack, installMicroProfile } from "@supabase/stack";
import type { ServiceName, VersionManifest } from "@supabase/stack";
import { cloneDir } from "./cowClone.ts";
import { baseTemplateKey, templateKey } from "./PodManifest.ts";

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Builds and caches golden Postgres template data directories that pods are later
 * CoW-cloned from.
 *
 * - "base" templates are a one-shot `postgres`-only stack boot: `postgres-init`
 *   applies the baseline roles/schemas/migrations exactly as it does for a normal
 *   stack, then the micro profile (`micro.conf`/`pod.conf` includes) is installed
 *   before the data dir is frozen under `root/pg-<hash>/data`.
 * - "warm" templates clone a base template and boot the requested services once
 *   so each self-migrates against a `provisioned` (post-init) data dir, then
 *   freeze the result under `root/<templateKey>/data`. An empty service list has
 *   nothing to warm, so it resolves to the base template directly.
 *
 * Builds are concurrency-safe on one host via a per-key lockfile created with the
 * `wx` flag; a stale lock (holder crashed) is reclaimed after `LOCK_STALE_MS`.
 */
export class TemplateStore {
  constructor(private readonly root: string) {}

  private dataDir(key: string): string {
    return join(this.root, key, "data");
  }

  async has(key: string): Promise<boolean> {
    return stat(join(this.root, key, "template.json")).then(
      () => true,
      () => false,
    );
  }

  async ensureBaseTemplate(postgresVersion: string): Promise<string> {
    const key = baseTemplateKey(postgresVersion);
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = join(this.root, `${key}.build`);
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true });
      const buildDataDir = join(buildDir, "data");
      // One-shot stack: postgres only, non-provisioned -> postgres-init applies
      // roles/schemas/baseline migrations exactly as it does for a normal stack.
      const stack = await createStack({
        postgres: { version: postgresVersion, dataDir: buildDataDir },
        postgrest: false,
        auth: false,
        edgeRuntime: false,
        realtime: false,
        storage: false,
        imgproxy: false,
        mailpit: false,
        pgmeta: false,
        studio: false,
        analytics: false,
        vector: false,
        pooler: false,
        functions: false,
      });
      try {
        await stack.start();
        await stack.ready();
      } finally {
        await stack.dispose();
      }
      await installMicroProfile(buildDataDir);
      await this.freeze(buildDir, key, { key, postgresVersion, builtAt: new Date().toISOString() });
      return this.dataDir(key);
    });
  }

  async ensureWarmTemplate(
    versions: Partial<VersionManifest>,
    enabledServices: ReadonlyArray<ServiceName>,
  ): Promise<string> {
    const pgVersion = versions.postgres;
    if (pgVersion === undefined) throw new Error("versions.postgres is required");
    const base = await this.ensureBaseTemplate(pgVersion);
    if (enabledServices.length === 0) return base;

    const key = templateKey(versions, enabledServices);
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = join(this.root, `${key}.build`);
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true });
      const buildDataDir = join(buildDir, "data");
      await cloneDir(base, buildDataDir);

      // The clone is already post-init, so postgres-init is skipped (`provisioned: true`);
      // each enabled service boots once and self-migrates against it.
      const stack = await createStack({
        postgres: {
          version: pgVersion,
          dataDir: buildDataDir,
          provisioned: true,
          profile: "micro",
        },
        postgrest: enabledServices.includes("postgrest") ? { version: versions.postgrest } : false,
        auth: enabledServices.includes("auth") ? { version: versions.auth } : false,
        edgeRuntime: enabledServices.includes("edge-runtime")
          ? { version: versions["edge-runtime"] }
          : false,
        realtime: enabledServices.includes("realtime") ? { version: versions.realtime } : false,
        storage: enabledServices.includes("storage") ? { version: versions.storage } : false,
        imgproxy: enabledServices.includes("imgproxy") ? { version: versions.imgproxy } : false,
        mailpit: enabledServices.includes("mailpit") ? { version: versions.mailpit } : false,
        pgmeta: enabledServices.includes("pgmeta") ? { version: versions.pgmeta } : false,
        studio: enabledServices.includes("studio") ? { version: versions.studio } : false,
        analytics: enabledServices.includes("analytics") ? { version: versions.analytics } : false,
        vector: enabledServices.includes("vector") ? { version: versions.vector } : false,
        pooler: enabledServices.includes("pooler") ? { version: versions.pooler } : false,
        functions: false,
      });
      try {
        await stack.start();
        await stack.ready();
      } finally {
        await stack.dispose();
      }
      await this.freeze(buildDir, key, {
        key,
        versions,
        enabledServices,
        builtAt: new Date().toISOString(),
      });
      return this.dataDir(key);
    });
  }

  private async freeze(buildDir: string, key: string, marker: unknown): Promise<void> {
    const finalDir = join(this.root, key);
    await writeFile(join(buildDir, "template.json"), JSON.stringify(marker));
    await rm(finalDir, { recursive: true, force: true });
    await rename(buildDir, finalDir);
  }

  private async withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, `${key}.lock`);
    await mkdir(this.root, { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.close();
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const s = await stat(lockPath).catch(() => undefined);
        if (s && Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      }
    }
    try {
      return await body();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}
