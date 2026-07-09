import { rename, rm } from "node:fs/promises";
import {
  SERVICE_NAMES,
  validateEnabledServiceDependencies,
  type ServiceName,
  type VersionManifest,
} from "@supabase/stack";
import { cloneDir } from "./cowClone.ts";
import { resolveTemplateVersions, type PodManifest } from "./PodManifest.ts";
import type { PodRegistry } from "./PodRegistry.ts";
import type { PortRegistry } from "./PortRegistry.ts";
import type { TemplateStore } from "./TemplateStore.ts";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const NATIVE_FLEET_SERVICES = new Set<ServiceName>(["postgres", "postgrest", "auth"]);
const SERVICE_NAME_SET = new Set<string>(SERVICE_NAMES);

/**
 * JS callers can pass junk despite the types; anything unknown or non-boolean
 * would be persisted into pod.json only for PodRegistry's strict parser to
 * reject the whole manifest on the next read, turning the pod into an
 * unreadable "unknown pod". Reject it up front instead.
 */
function validateServices(services: Partial<Record<ServiceName, boolean>>): void {
  for (const [name, enabled] of Object.entries(services)) {
    if (!SERVICE_NAME_SET.has(name) || typeof enabled !== "boolean") {
      throw new Error(`invalid service entry: ${name}=${String(enabled)}`);
    }
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
  readonly versions: Partial<VersionManifest>;
  readonly services?: Partial<Record<ServiceName, boolean>>;
  readonly flags?: { readonly supautils?: boolean };
  /** Build/use a warm template (services pre-migrated). Default: base template. */
  readonly warm?: boolean;
}

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
    validateServices(opts.services ?? {});
    const enabled = SERVICE_NAMES.filter((name) => opts.services?.[name] === true);
    const dependencyError = validateEnabledServiceDependencies(new Set(enabled));
    if (dependencyError !== undefined) {
      throw new Error(dependencyError);
    }
    const unsupported = enabled.filter((service) => !NATIVE_FLEET_SERVICES.has(service));
    if (unsupported.length > 0) {
      throw new Error(
        `fleet native mode only supports postgrest and auth pods; unsupported services: ${unsupported.join(", ")}`,
      );
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
        services: opts.services ?? {},
        flags: { supautils: opts.flags?.supautils ?? false },
        warm: opts.warm === true,
        ports: allocated.ports,
        internalPorts: allocated.internalPorts,
        postgresPassword,
        createdAt: new Date().toISOString(),
      };
      await pods.write(manifest);
      return manifest;
    } catch (err) {
      await ports.release(opts.id).catch(() => {});
      await rm(pods.dataDir(opts.id), { recursive: true, force: true }).catch(() => {});
      await rm(pods.podDir(opts.id), { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /** Re-clones the pod's data dir from the same kind of template it was created from. */
  async reset(id: string): Promise<void> {
    const { templates, pods, postgresPassword } = this.deps;
    const manifest = await pods.read(id);
    if (manifest === undefined) throw new Error(`unknown pod: ${id}`);
    const pgVersion = manifest.versions.postgres;
    if (pgVersion === undefined) throw new Error(`pod ${id} has no postgres version`);
    const enabled = SERVICE_NAMES.filter((name) => manifest.services[name] === true);
    const template = manifest.warm
      ? await templates.ensureWarmTemplate(manifest.versions, enabled)
      : await templates.ensureBaseTemplate(pgVersion);
    const dataDir = pods.dataDir(id);
    const tmpDataDir = `${dataDir}.reset-${process.pid}-${Date.now()}`;
    const backupDataDir = `${dataDir}.backup-${process.pid}-${Date.now()}`;
    let backedUp = false;
    await cloneDir(template, tmpDataDir);
    try {
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
      if (backedUp) {
        await rm(dataDir, { recursive: true, force: true }).catch(() => {});
        await rename(backupDataDir, dataDir).catch(() => {});
      }
      throw error;
    } finally {
      await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {});
    }
    // The reset is committed once the manifest is rewritten; a failure to
    // delete the old data dir must not trigger the rollback above (which
    // would restore the old data under the new manifest's credentials).
    await rm(backupDataDir, { recursive: true, force: true }).catch(() => {});
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
        ports: allocated.ports,
        internalPorts: allocated.internalPorts,
        createdAt: new Date().toISOString(),
      };
      await pods.write(manifest);
      return manifest;
    } catch (err) {
      await ports.release(newId).catch(() => {});
      await rm(pods.dataDir(newId), { recursive: true, force: true }).catch(() => {});
      await rm(pods.podDir(newId), { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async destroy(id: string): Promise<void> {
    const { pods, ports } = this.deps;
    await pods.remove(id);
    await ports.release(id);
  }
}
