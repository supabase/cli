import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeServiceVersion,
  SERVICE_NAMES,
  type ServiceName,
  type VersionManifest,
} from "../src/versions.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const dockerfilePath = path.join(repoRoot, "apps/cli-go/pkg/config/templates/Dockerfile");
const versionsPath = path.join(repoRoot, "packages/stack/src/versions.ts");

const fromLinePattern = /^FROM\s+(.+):([^:\s]+)\s+AS\s+([^\s#]+)/i;

const dockerfileAliases = new Map<string, ServiceName>([
  ["pg", "postgres"],
  ["postgrest", "postgrest"],
  ["gotrue", "auth"],
  ["edgeruntime", "edge-runtime"],
  ["realtime", "realtime"],
  ["storage", "storage"],
  ["imgproxy", "imgproxy"],
  ["mailpit", "mailpit"],
  ["pgmeta", "pgmeta"],
  ["studio", "studio"],
  ["logflare", "analytics"],
  ["vector", "vector"],
  ["supavisor", "pooler"],
]);

const ignoredAliases = new Set(["kong", "differ", "migra", "pgprove"]);

function assertFullManifest(
  versions: Partial<Record<ServiceName, string>>,
): asserts versions is VersionManifest {
  const missing = SERVICE_NAMES.filter((service) => versions[service] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing Dockerfile versions for: ${missing.join(", ")}`);
  }
}

export function readVersionManifestFromDockerfile(dockerfile: string): VersionManifest {
  const versions: Partial<Record<ServiceName, string>> = {};

  for (const rawLine of dockerfile.split("\n")) {
    const line = rawLine.trim();
    const match = fromLinePattern.exec(line);
    if (match === null) {
      continue;
    }

    const [, , tag, alias] = match;
    if (tag === undefined || alias === undefined) {
      continue;
    }

    if (ignoredAliases.has(alias)) {
      continue;
    }

    const service = dockerfileAliases.get(alias);
    if (service === undefined) {
      throw new Error(`Unknown Dockerfile image alias '${alias}'.`);
    }
    if (versions[service] !== undefined) {
      throw new Error(`Duplicate Dockerfile version for '${service}'.`);
    }

    versions[service] = normalizeServiceVersion(service, tag);
  }

  assertFullManifest(versions);
  return versions;
}

function renderManifestKey(service: ServiceName): string {
  return /^[a-zA-Z_$][\w$]*$/.test(service) ? service : JSON.stringify(service);
}

export function renderDefaultVersions(versions: VersionManifest): string {
  const lines = SERVICE_NAMES.map(
    (service) => `  ${renderManifestKey(service)}: ${JSON.stringify(versions[service])},`,
  );
  return ["export const DEFAULT_VERSIONS: VersionManifest = {", ...lines, "} as const;"].join("\n");
}

export function syncDefaultVersionsSource(source: string, versions: VersionManifest): string {
  const startMarker = "export const DEFAULT_VERSIONS: VersionManifest = {";
  const endMarker = "\n} as const;";
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error("Could not find DEFAULT_VERSIONS declaration.");
  }

  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error("Could not find DEFAULT_VERSIONS declaration end.");
  }

  return `${source.slice(0, start)}${renderDefaultVersions(versions)}${source.slice(
    end + endMarker.length,
  )}`;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const versionsSource = await readFile(versionsPath, "utf8");
  const versions = readVersionManifestFromDockerfile(dockerfile);
  const syncedSource = syncDefaultVersionsSource(versionsSource, versions);

  if (syncedSource === versionsSource) {
    console.log("DEFAULT_VERSIONS is already synced with the Dockerfile manifest.");
    return;
  }

  if (checkOnly) {
    console.error("DEFAULT_VERSIONS is out of sync with the Dockerfile manifest.");
    process.exitCode = 1;
    return;
  }

  await Bun.write(versionsPath, syncedSource);
  console.log("Synced DEFAULT_VERSIONS with the Dockerfile manifest.");
}

if (import.meta.main) {
  await main();
}
