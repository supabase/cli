import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import {
  SERVICE_NAMES,
  validateEnabledServiceDependencies,
  type FunctionsConfig,
  type VersionManifest,
} from "@supabase/stack";
import type { ProvisionedServiceName, ProvisionedStackVersions } from "@supabase/stack/provisioned";
import { cloneDir } from "./cowClone.ts";
import { resolveTemplateVersions, type PodManifest } from "./PodManifest.ts";
import type { PodRegistry } from "./PodRegistry.ts";
import type { PortRegistry } from "./PortRegistry.ts";
import type { TemplateStore } from "./TemplateStore.ts";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function throwWithCleanup(
  primary: unknown,
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
  message: string,
): never {
  const cleanupErrors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupErrors.length === 0) throw primary;
  throw new AggregateError([primary, ...cleanupErrors], message);
}

const SERVICE_NAME_SET = new Set<string>(SERVICE_NAMES);

/**
 * JS callers can pass junk despite the types; anything unknown or non-boolean
 * would be persisted into pod.json only for PodRegistry's strict parser to
 * reject the whole manifest on the next read, turning the pod into an
 * unreadable "unknown pod". Reject it up front instead.
 */
function validateServices(services: ReadonlyArray<ProvisionedServiceName>): void {
  const seen = new Set<string>();
  for (const name of services) {
    if (!SERVICE_NAME_SET.has(name) || seen.has(name)) {
      throw new Error(`invalid service entry: ${String(name)}`);
    }
    seen.add(name);
  }
}

/** Same rationale as validateServices: junk versions would persist into a pod.json the registry's strict parser then refuses to read back. */
function validateVersions(versions: Partial<VersionManifest>): void {
  for (const [name, version] of Object.entries(versions)) {
    if (!SERVICE_NAME_SET.has(name) || typeof version !== "string" || version.length === 0) {
      throw new Error(`invalid version entry: ${name}=${String(version)}`);
    }
  }
}

export interface CreatePodOptions {
  readonly id: string;
  readonly versions: ProvisionedStackVersions;
  readonly services?: ReadonlyArray<ProvisionedServiceName>;
  readonly flags?: { readonly supautils?: boolean };
  /** Build/use a warm template (services pre-migrated). Default: base template. */
  readonly warm?: boolean;
  readonly projectDir?: string;
  readonly functions?: FunctionsConfig | false;
}

const randomSecret = (prefix = "") => `${prefix}${randomBytes(32).toString("base64url")}`;

/**
 * Creates, resets, forks, and destroys pods by CoW-cloning template data
 * directories (via `TemplateStore`) into per-pod data directories tracked by
 * `PodRegistry`, and allocating/releasing ports via `PortRegistry`.
 */
export class Provisioner {
  constructor(
    private readonly deps: {
      readonly templates: TemplateStore;
      readonly pods: PodRegistry;
      readonly ports: PortRegistry;
      readonly postgresPassword: string;
    },
  ) {}

  async create(opts: CreatePodOptions): Promise<PodManifest> {
    const { templates, pods, ports, postgresPassword } = this.deps;
    // `exists` (not just `read`) so a pod directory with a corrupt/older
    // manifest also counts as occupied — otherwise the failed clone below
    // would hit the existing data dir and the catch-block cleanup would
    // delete pod data this create never made.
    if (await pods.exists(opts.id)) {
      throw new Error(`pod already exists: ${opts.id}`);
    }
    const pgVersion = opts.versions.postgres;
    if (pgVersion === undefined) throw new Error("versions.postgres is required");
    validateVersions(opts.versions);
    const enabled = [...(opts.services ?? [])];
    validateServices(enabled);
    const dependencyError = validateEnabledServiceDependencies(new Set(enabled));
    if (dependencyError !== undefined) {
      throw new Error(dependencyError);
    }
    const resolvedVersions = resolveTemplateVersions(opts.versions, enabled);
    const template =
      opts.warm === true
        ? await templates.ensureWarmTemplate(resolvedVersions, enabled)
        : await templates.ensureBaseTemplate(pgVersion);
    const allocated = await ports.allocate(opts.id);
    try {
      await cloneDir(template, pods.dataDir(opts.id));
      const manifest: PodManifest = {
        id: opts.id,
        versions: resolvedVersions,
        services: enabled,
        flags: { supautils: opts.flags?.supautils ?? false },
        warm: opts.warm === true,
        dbPort: allocated.dbPort,
        apiPort: allocated.apiPort,
        postgresPassword,
        jwtSecret: randomSecret(),
        publishableKey: randomSecret("sb_publishable_"),
        secretKey: randomSecret("sb_secret_"),
        ...(opts.projectDir === undefined ? {} : { projectDir: opts.projectDir }),
        ...(opts.functions === undefined ? {} : { functions: opts.functions }),
        createdAt: new Date().toISOString(),
      };
      await pods.write(manifest);
      return manifest;
    } catch (err) {
      const cleanup = await Promise.allSettled([
        ports.release(opts.id),
        rm(pods.podDir(opts.id), { recursive: true, force: true }),
      ]);
      throwWithCleanup(err, cleanup, `Failed to create and clean up pod ${opts.id}`);
    }
  }

  /** Re-clones the pod's data dir from the same kind of template it was created from. */
  async reset(id: string): Promise<void> {
    const { templates, pods, postgresPassword } = this.deps;
    const manifest = await pods.read(id);
    if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
    const pgVersion = manifest.versions.postgres;
    if (pgVersion === undefined) throw new Error(`pod ${id} has no postgres version`);
    const enabled = manifest.services;
    const template = manifest.warm
      ? await templates.ensureWarmTemplate(manifest.versions, enabled)
      : await templates.ensureBaseTemplate(pgVersion);
    const dataDir = pods.dataDir(id);
    const tmpDataDir = `${dataDir}.reset-${process.pid}-${Date.now()}`;
    const backupDataDir = `${dataDir}.backup-${process.pid}-${Date.now()}`;
    let backedUp = false;
    try {
      await cloneDir(template, tmpDataDir);
      await rename(dataDir, backupDataDir).then(
        () => {
          backedUp = true;
        },
        (error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        },
      );
      await rename(tmpDataDir, dataDir);
      await pods.write({ ...manifest, postgresPassword });
    } catch (error) {
      const cleanup: Array<PromiseSettledResult<unknown>> = [];
      if (backedUp) {
        const removeNewData = await Promise.allSettled([
          rm(dataDir, { recursive: true, force: true }),
        ]);
        cleanup.push(...removeNewData);
        if (removeNewData[0]?.status === "fulfilled") {
          cleanup.push(...(await Promise.allSettled([rename(backupDataDir, dataDir)])));
        }
      }
      cleanup.push(
        ...(await Promise.allSettled([rm(tmpDataDir, { recursive: true, force: true })])),
      );
      throwWithCleanup(error, cleanup, `Failed to reset and restore pod ${id}`);
    }
    await rm(tmpDataDir, { recursive: true, force: true });
    // The reset is committed once the manifest is rewritten. Cleanup remains
    // strict, but the old data is never restored after that commit point.
    await rm(backupDataDir, { recursive: true, force: true });
  }

  /** Caller must ensure the source pod is stopped/suspended first. */
  async fork(sourceId: string, newId: string): Promise<PodManifest> {
    const { pods, ports } = this.deps;
    const source = await pods.read(sourceId);
    if (source === undefined) throw new Error(`unknown pod: ${sourceId}`);
    if (await pods.exists(newId)) {
      throw new Error(`pod already exists: ${newId}`);
    }
    const allocated = await ports.allocate(newId);
    try {
      await cloneDir(pods.dataDir(sourceId), pods.dataDir(newId));
      const manifest: PodManifest = {
        ...source,
        id: newId,
        dbPort: allocated.dbPort,
        apiPort: allocated.apiPort,
        createdAt: new Date().toISOString(),
      };
      await pods.write(manifest);
      return manifest;
    } catch (err) {
      const cleanup = await Promise.allSettled([
        ports.release(newId),
        rm(pods.podDir(newId), { recursive: true, force: true }),
      ]);
      throwWithCleanup(err, cleanup, `Failed to fork and clean up pod ${newId}`);
    }
  }

  async destroy(id: string): Promise<void> {
    const { pods, ports } = this.deps;
    await pods.remove(id);
    await ports.release(id);
  }
}
