import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { STACK_SERVICE_NAMES } from "@supabase/stack";
import type { ServiceName } from "@supabase/stack";
import type { ProvisionedServiceName } from "@supabase/stack/provisioned";
import type { PodManifest } from "./PodManifest.ts";
import type { VersionManifest } from "@supabase/stack";
import { FLEET_PUBLIC_PORT_RANGE } from "./PortRegistry.ts";

const POD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function serviceNameFrom(value: string): ServiceName | undefined {
  switch (value) {
    case "postgres":
    case "postgrest":
    case "auth":
    case "edge-runtime":
    case "realtime":
    case "storage":
    case "imgproxy":
    case "mailpit":
    case "pgmeta":
    case "studio":
    case "analytics":
    case "vector":
    case "pooler":
      return value;
    default:
      return undefined;
  }
}

function isValidPodId(id: string): boolean {
  return POD_ID_RE.test(id) && basename(id) === id;
}

function validatePodId(id: string): string {
  if (!isValidPodId(id)) {
    throw new Error(`invalid pod id: ${id}`);
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isFleetPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FLEET_PUBLIC_PORT_RANGE.min &&
    value <= FLEET_PUBLIC_PORT_RANGE.max
  );
}

function parseVersions(value: unknown): Partial<VersionManifest> | undefined {
  if (!isRecord(value)) return undefined;
  let postgres: string | undefined;
  let postgrest: string | undefined;
  let auth: string | undefined;
  let edgeRuntime: string | undefined;
  let realtime: string | undefined;
  let storage: string | undefined;
  let imgproxy: string | undefined;
  let mailpit: string | undefined;
  let pgmeta: string | undefined;
  let studio: string | undefined;
  let analytics: string | undefined;
  let vector: string | undefined;
  let pooler: string | undefined;
  for (const [name, version] of Object.entries(value)) {
    const service = serviceNameFrom(name);
    if (service === undefined || typeof version !== "string") return undefined;
    switch (service) {
      case "postgres":
        postgres = version;
        break;
      case "postgrest":
        postgrest = version;
        break;
      case "auth":
        auth = version;
        break;
      case "edge-runtime":
        edgeRuntime = version;
        break;
      case "realtime":
        realtime = version;
        break;
      case "storage":
        storage = version;
        break;
      case "imgproxy":
        imgproxy = version;
        break;
      case "mailpit":
        mailpit = version;
        break;
      case "pgmeta":
        pgmeta = version;
        break;
      case "studio":
        studio = version;
        break;
      case "analytics":
        analytics = version;
        break;
      case "vector":
        vector = version;
        break;
      case "pooler":
        pooler = version;
        break;
    }
  }
  return {
    ...(postgres === undefined ? {} : { postgres }),
    ...(postgrest === undefined ? {} : { postgrest }),
    ...(auth === undefined ? {} : { auth }),
    ...(edgeRuntime === undefined ? {} : { "edge-runtime": edgeRuntime }),
    ...(realtime === undefined ? {} : { realtime }),
    ...(storage === undefined ? {} : { storage }),
    ...(imgproxy === undefined ? {} : { imgproxy }),
    ...(mailpit === undefined ? {} : { mailpit }),
    ...(pgmeta === undefined ? {} : { pgmeta }),
    ...(studio === undefined ? {} : { studio }),
    ...(analytics === undefined ? {} : { analytics }),
    ...(vector === undefined ? {} : { vector }),
    ...(pooler === undefined ? {} : { pooler }),
  };
}

function parseServices(value: unknown): ReadonlyArray<ProvisionedServiceName> | undefined {
  if (!Array.isArray(value)) return undefined;
  const services = new Set<ProvisionedServiceName>();
  for (const name of value) {
    if (!isProvisionedServiceName(name) || services.has(name)) {
      return undefined;
    }
    services.add(name);
  }
  return [...services];
}

function isProvisionedServiceName(value: unknown): value is ProvisionedServiceName {
  return typeof value === "string" && STACK_SERVICE_NAMES.some((service) => service === value);
}

function parseFunctions(value: unknown): PodManifest["functions"] | undefined {
  if (value === undefined || value === false) return value;
  if (!isRecord(value)) return undefined;
  if (value.envFile !== undefined && typeof value.envFile !== "string") return undefined;
  if (value.noVerifyJwt !== undefined && typeof value.noVerifyJwt !== "boolean") return undefined;
  return {
    ...(value.envFile === undefined ? {} : { envFile: value.envFile }),
    ...(value.noVerifyJwt === undefined ? {} : { noVerifyJwt: value.noVerifyJwt }),
  };
}

function parseManifest(value: unknown): PodManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !isValidPodId(value.id)) return undefined;
  const versions = parseVersions(value.versions);
  const services = parseServices(value.services);
  if (
    versions === undefined ||
    services === undefined ||
    !isFleetPort(value.dbPort) ||
    !isFleetPort(value.apiPort) ||
    value.dbPort === value.apiPort
  ) {
    return undefined;
  }
  // Provisioning always records the exact versions a pod was initialized
  // with (see resolveTemplateVersions); a manifest missing them would make
  // the next wake silently boot whatever the CURRENT defaults are against
  // an existing data dir, so treat it as corrupt.
  if (versions.postgres === undefined) return undefined;
  for (const service of services) {
    if (versions[service] === undefined) return undefined;
  }
  if (!isRecord(value.flags) || typeof value.flags.supautils !== "boolean") return undefined;
  if (typeof value.warm !== "boolean") return undefined;
  if (typeof value.postgresPassword !== "string" || value.postgresPassword.length === 0) {
    return undefined;
  }
  if (
    typeof value.jwtSecret !== "string" ||
    value.jwtSecret.length < 32 ||
    typeof value.publishableKey !== "string" ||
    value.publishableKey.length === 0 ||
    typeof value.secretKey !== "string" ||
    value.secretKey.length === 0
  ) {
    return undefined;
  }
  if (value.projectDir !== undefined && typeof value.projectDir !== "string") return undefined;
  const functions = parseFunctions(value.functions);
  if (value.functions !== undefined && functions === undefined) return undefined;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    return undefined;
  }
  return {
    id: value.id,
    versions: { ...versions, postgres: versions.postgres },
    services,
    flags: { supautils: value.flags.supautils },
    warm: value.warm,
    dbPort: value.dbPort,
    apiPort: value.apiPort,
    postgresPassword: value.postgresPassword,
    jwtSecret: value.jwtSecret,
    publishableKey: value.publishableKey,
    secretKey: value.secretKey,
    ...(value.projectDir === undefined ? {} : { projectDir: value.projectDir }),
    ...(value.functions === undefined ? {} : { functions }),
    createdAt: value.createdAt,
  };
}

/**
 * Persists pod manifests on disk, one per pod directory: `podsRoot/<id>/pod.json`.
 * The pod's data directory lives alongside it at `podsRoot/<id>/data`.
 */
export class PodRegistry {
  constructor(private readonly podsRoot: string) {}

  podDir(id: string): string {
    return join(this.podsRoot, validatePodId(id));
  }

  dataDir(id: string): string {
    return join(this.podDir(id), "data");
  }

  /**
   * Whether ANY pod directory exists for `id`, even one whose pod.json is
   * missing or unreadable — provisioning must treat those as occupied rather
   * than as free ids whose data it may clobber.
   */
  async exists(id: string): Promise<boolean> {
    return stat(this.podDir(id)).then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      },
    );
  }

  async read(id: string): Promise<PodManifest | undefined> {
    const raw = await readFile(join(this.podDir(id), "pod.json"), "utf8").catch(
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      },
    );
    if (raw === undefined) return undefined;
    try {
      const manifest = parseManifest(JSON.parse(raw));
      return manifest?.id === id ? manifest : undefined;
    } catch {
      return undefined;
    }
  }

  async write(manifest: PodManifest): Promise<void> {
    const parsed = parseManifest(manifest);
    if (parsed === undefined || parsed.id !== manifest.id) {
      throw new Error(`invalid pod manifest: ${manifest.id}`);
    }
    const dir = this.podDir(manifest.id);
    // The manifest holds the pod's postgres password in plaintext, so keep the
    // directory and file owner-only regardless of the process umask.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `pod.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(tmp, join(dir, "pod.json"));
  }

  /**
   * All pod directory ids on disk, INCLUDING those whose pod.json is missing
   * or malformed — startup reconciliation must reap stale postmasters even
   * for pods it can no longer parse.
   */
  async listIds(): Promise<string[]> {
    // Only a MISSING root means "no pods". Any other scan failure (EACCES,
    // ENOTDIR, transient I/O) must propagate: reporting an empty fleet would
    // let startup reconciliation free every port reservation while the pod
    // directories still exist behind the unreadable root.
    const entries = await readdir(this.podsRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      },
    );
    // Only directories: a stray regular file whose name matches the id regex
    // would make startup cleanup paths fail with ENOTDIR.
    return entries
      .filter((entry) => entry.isDirectory() && isValidPodId(entry.name))
      .map((entry) => entry.name);
  }

  async list(): Promise<PodManifest[]> {
    const ids = await this.listIds();
    const manifests = await Promise.all(ids.map((id) => this.read(id)));
    return manifests.filter((m): m is PodManifest => m !== undefined);
  }

  async remove(id: string): Promise<void> {
    await rm(this.podDir(id), { recursive: true, force: true });
  }
}
