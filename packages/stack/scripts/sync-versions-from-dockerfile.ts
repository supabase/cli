// oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/node-builtin-import -- Standalone Bun maintenance script intentionally uses native filesystem, process, and console APIs at its CLI boundary.

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
const catalogPath = path.join(repoRoot, "packages/stack/src/ServiceCatalog.ts");

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

    versions[service] = normalizeServiceVersion(service, tag, "docker");
  }

  assertFullManifest(versions);
  return versions;
}

export function syncDefaultVersionsSource(source: string, versions: VersionManifest): string {
  let updated = source;
  for (const service of SERVICE_NAMES) {
    const nameMarker = `    name: ${JSON.stringify(service)},`;
    const entryStart = updated.indexOf(nameMarker);
    if (entryStart === -1) {
      throw new Error(`Could not find catalog entry for '${service}'.`);
    }

    const defaultsMarker = "    defaultVersions:";
    const defaultsStart = updated.indexOf(defaultsMarker, entryStart + nameMarker.length);
    if (defaultsStart === -1 || defaultsStart - entryStart > 300) {
      throw new Error(`Could not find defaultVersions for '${service}'.`);
    }
    const defaultsEnd = updated.indexOf("},", defaultsStart);
    const dockerMarker = "docker: ";
    const dockerStart = updated.indexOf(dockerMarker, defaultsStart);
    if (defaultsEnd === -1 || dockerStart === -1 || dockerStart > defaultsEnd) {
      throw new Error(`Could not find Docker defaultVersion for '${service}'.`);
    }
    const valueStart = dockerStart + dockerMarker.length;
    const quoteStart = updated.indexOf('"', valueStart);
    const quoteEnd = quoteStart === -1 ? -1 : updated.indexOf('"', quoteStart + 1);
    if (quoteStart === -1 || quoteEnd === -1) {
      throw new Error(`Could not find Docker defaultVersion value for '${service}'.`);
    }
    updated = `${updated.slice(0, quoteStart + 1)}${versions[service]}${updated.slice(quoteEnd)}`;
  }
  return updated;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const catalogSource = await readFile(catalogPath, "utf8");
  const versions = readVersionManifestFromDockerfile(dockerfile);
  const syncedSource = syncDefaultVersionsSource(catalogSource, versions);

  if (syncedSource === catalogSource) {
    console.log("DEFAULT_VERSIONS is already synced with the Dockerfile manifest.");
    return;
  }

  if (checkOnly) {
    console.error("DEFAULT_VERSIONS is out of sync with the Dockerfile manifest.");
    process.exitCode = 1;
    return;
  }

  await Bun.write(catalogPath, syncedSource);
  console.log("Synced DEFAULT_VERSIONS with the Dockerfile manifest.");
}

if (import.meta.main) {
  await main();
}
