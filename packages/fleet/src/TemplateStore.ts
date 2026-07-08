import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createStack, installMicroProfile, resolvePostgresPassword } from "@supabase/stack";
import type { ServiceName, VersionManifest } from "@supabase/stack";
import { cloneDir } from "./cowClone.ts";
import { baseTemplateKey, resolveTemplateVersions, templateKey } from "./PodManifest.ts";

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;
const LOCK_HEARTBEAT_MS = Math.floor(LOCK_STALE_MS / 3);
const STACK_BOOT_LOCK_KEY = "__stack-boot";

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
    const postgresPassword = resolvePostgresPassword();
    const key = baseTemplateKey(postgresVersion, { postgresPassword });
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = await this.createBuildDir(key);
      let frozen = false;
      const buildDataDir = join(buildDir, "data");
      try {
        await this.withStackBootLock(async () => {
          // One-shot stack: postgres only, non-provisioned -> postgres-init applies
          // roles/schemas/baseline migrations exactly as it does for a normal stack.
          const stack = await createStack({
            mode: "native",
            postgres: {
              version: postgresVersion,
              dataDir: buildDataDir,
              password: postgresPassword,
            },
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
        });
        await installMicroProfile(buildDataDir);
        await this.freeze(buildDir, key, {
          key,
          postgresVersion,
          builtAt: new Date().toISOString(),
        });
        frozen = true;
        return this.dataDir(key);
      } finally {
        if (!frozen) await rm(buildDir, { recursive: true, force: true });
      }
    });
  }

  async ensureWarmTemplate(
    versions: Partial<VersionManifest>,
    enabledServices: ReadonlyArray<ServiceName>,
  ): Promise<string> {
    const pgVersion = versions.postgres;
    if (pgVersion === undefined) throw new Error("versions.postgres is required");
    const postgresPassword = resolvePostgresPassword();
    const base = await this.ensureBaseTemplate(pgVersion);
    if (enabledServices.length === 0) return base;

    const resolvedVersions = resolveTemplateVersions(versions, enabledServices);
    const key = templateKey(resolvedVersions, enabledServices, { postgresPassword });
    if (await this.has(key)) return this.dataDir(key);
    return this.withLock(key, async () => {
      if (await this.has(key)) return this.dataDir(key);
      const buildDir = await this.createBuildDir(key);
      let frozen = false;
      const buildDataDir = join(buildDir, "data");

      try {
        await cloneDir(base, buildDataDir);

        await this.withStackBootLock(async () => {
          // The clone is already post-init, so postgres-init is skipped (`provisioned: true`);
          // each enabled service boots once and self-migrates against it.
          const stack = await createStack({
            mode: "native",
            postgres: {
              version: pgVersion,
              dataDir: buildDataDir,
              password: postgresPassword,
              provisioned: true,
              profile: "micro",
            },
            postgrest: enabledServices.includes("postgrest")
              ? { version: resolvedVersions.postgrest }
              : false,
            auth: enabledServices.includes("auth") ? { version: resolvedVersions.auth } : false,
            edgeRuntime: enabledServices.includes("edge-runtime")
              ? { version: resolvedVersions["edge-runtime"] }
              : false,
            realtime: enabledServices.includes("realtime")
              ? { version: resolvedVersions.realtime }
              : false,
            storage: enabledServices.includes("storage")
              ? { version: resolvedVersions.storage }
              : false,
            imgproxy: enabledServices.includes("imgproxy")
              ? { version: resolvedVersions.imgproxy }
              : false,
            mailpit: enabledServices.includes("mailpit")
              ? { version: resolvedVersions.mailpit }
              : false,
            pgmeta: enabledServices.includes("pgmeta")
              ? { version: resolvedVersions.pgmeta }
              : false,
            studio: enabledServices.includes("studio")
              ? { version: resolvedVersions.studio }
              : false,
            analytics: enabledServices.includes("analytics")
              ? { version: resolvedVersions.analytics }
              : false,
            vector: enabledServices.includes("vector")
              ? { version: resolvedVersions.vector }
              : false,
            pooler: enabledServices.includes("pooler")
              ? { version: resolvedVersions.pooler }
              : false,
            functions: false,
          });
          try {
            await stack.start();
            await stack.ready();
          } finally {
            await stack.dispose();
          }
        });
        await this.freeze(buildDir, key, {
          key,
          versions: resolvedVersions,
          enabledServices,
          builtAt: new Date().toISOString(),
        });
        frozen = true;
        return this.dataDir(key);
      } finally {
        if (!frozen) await rm(buildDir, { recursive: true, force: true });
      }
    });
  }

  private async createBuildDir(key: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return mkdtemp(join(this.root, `${key}.build-`));
  }

  private async withStackBootLock<T>(body: () => Promise<T>): Promise<T> {
    return this.withLock(STACK_BOOT_LOCK_KEY, body);
  }

  private async freeze(buildDir: string, key: string, marker: unknown): Promise<void> {
    const finalDir = join(this.root, key);
    await writeFile(join(buildDir, "template.json"), JSON.stringify(marker));
    await rm(finalDir, { recursive: true, force: true });
    await rename(buildDir, finalDir);
  }

  private async withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const lockPath = join(this.root, `${key}.lock`);
    const lockOwner = `${process.pid}:${Date.now()}:${Math.random()}`;
    let lockHandle: FileHandle | undefined;
    await mkdir(this.root, { recursive: true });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(lockOwner);
          lockHandle = handle;
        } finally {
          if (lockHandle === undefined) await handle.close();
        }
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
    const heartbeat = setInterval(() => {
      if (lockHandle !== undefined) void this.refreshLock(lockHandle);
    }, LOCK_HEARTBEAT_MS);
    try {
      return await body();
    } finally {
      clearInterval(heartbeat);
      await this.releaseLock(lockPath, lockOwner);
      await lockHandle?.close().catch(() => {});
    }
  }

  private async refreshLock(lockHandle: FileHandle): Promise<void> {
    const now = new Date();
    await lockHandle.utimes(now, now).catch(() => {});
  }

  private async releaseLock(lockPath: string, lockOwner: string): Promise<void> {
    const currentOwner = await readFile(lockPath, "utf8").catch(() => undefined);
    if (currentOwner === lockOwner) {
      await unlink(lockPath).catch(() => {});
    }
  }
}
