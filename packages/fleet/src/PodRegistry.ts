import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SERVICE_NAMES } from "@supabase/stack";
import type { AllocatedPorts, ServiceName } from "@supabase/stack";
import type { PodManifest } from "./PodManifest.ts";

const POD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVICE_NAME_SET = new Set<string>(SERVICE_NAMES);

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

function isFleetPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 10_000 && value <= 65_535;
}

function parsePorts(value: unknown): AllocatedPorts | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isFleetPort(value.dbPort) ||
    !isFleetPort(value.apiPort) ||
    !isFleetPort(value.authPort) ||
    !isFleetPort(value.postgrestPort) ||
    !isFleetPort(value.postgrestAdminPort) ||
    !isFleetPort(value.edgeRuntimePort) ||
    !isFleetPort(value.edgeRuntimeInspectorPort) ||
    !isFleetPort(value.realtimePort) ||
    !isFleetPort(value.storagePort) ||
    !isFleetPort(value.imgproxyPort) ||
    !isFleetPort(value.mailpitPort) ||
    !isFleetPort(value.mailpitSmtpPort) ||
    !isFleetPort(value.mailpitPop3Port) ||
    !isFleetPort(value.pgmetaPort) ||
    !isFleetPort(value.studioPort) ||
    !isFleetPort(value.analyticsPort) ||
    !isFleetPort(value.poolerPort) ||
    !isFleetPort(value.poolerApiPort)
  ) {
    return undefined;
  }
  return {
    dbPort: value.dbPort,
    apiPort: value.apiPort,
    authPort: value.authPort,
    postgrestPort: value.postgrestPort,
    postgrestAdminPort: value.postgrestAdminPort,
    edgeRuntimePort: value.edgeRuntimePort,
    edgeRuntimeInspectorPort: value.edgeRuntimeInspectorPort,
    realtimePort: value.realtimePort,
    storagePort: value.storagePort,
    imgproxyPort: value.imgproxyPort,
    mailpitPort: value.mailpitPort,
    mailpitSmtpPort: value.mailpitSmtpPort,
    mailpitPop3Port: value.mailpitPop3Port,
    pgmetaPort: value.pgmetaPort,
    studioPort: value.studioPort,
    analyticsPort: value.analyticsPort,
    poolerPort: value.poolerPort,
    poolerApiPort: value.poolerApiPort,
  };
}

function parseVersions(value: unknown): PodManifest["versions"] | undefined {
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

function parseServices(value: unknown): Partial<Record<ServiceName, boolean>> | undefined {
  if (!isRecord(value)) return undefined;
  const services: Partial<Record<ServiceName, boolean>> = {};
  for (const [name, enabled] of Object.entries(value)) {
    const service = serviceNameFrom(name);
    if (service === undefined || !SERVICE_NAME_SET.has(name) || typeof enabled !== "boolean") {
      return undefined;
    }
    services[service] = enabled;
  }
  return services;
}

function parseManifest(value: unknown): PodManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !isValidPodId(value.id)) return undefined;
  const versions = parseVersions(value.versions);
  const services = parseServices(value.services);
  const ports = parsePorts(value.ports);
  if (versions === undefined || services === undefined || ports === undefined) return undefined;
  if (!isRecord(value.flags) || typeof value.flags.supautils !== "boolean") return undefined;
  if (typeof value.postgresPassword !== "string" || value.postgresPassword.length === 0) {
    return undefined;
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    return undefined;
  }
  return {
    id: value.id,
    versions,
    services,
    flags: { supautils: value.flags.supautils },
    ports,
    postgresPassword: value.postgresPassword,
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

  async read(id: string): Promise<PodManifest | undefined> {
    const raw = await readFile(join(this.podDir(id), "pod.json"), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const manifest = parseManifest(JSON.parse(raw));
      return manifest?.id === id ? manifest : undefined;
    } catch {
      return undefined;
    }
  }

  async write(manifest: PodManifest): Promise<void> {
    const dir = this.podDir(manifest.id);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `pod.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, join(dir, "pod.json"));
  }

  async list(): Promise<PodManifest[]> {
    const entries = await readdir(this.podsRoot).catch(() => [] as string[]);
    const manifests = await Promise.all(entries.filter(isValidPodId).map((id) => this.read(id)));
    return manifests.filter((m): m is PodManifest => m !== undefined);
  }

  async remove(id: string): Promise<void> {
    await rm(this.podDir(id), { recursive: true, force: true });
  }
}
