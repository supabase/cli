/**
 * Pins `packages/stack/src/Artifacts.ts` to the slim workloads named by
 * `apps/cli/src/shared/services/Dockerfile`. Native archive URLs are derived
 * from service + version. An entry that already carries a digest keeps one:
 * the published `ghcr.io/supabase/cli/<service>:<version>` manifest digest.
 *
 * Run: `bun .github/scripts/sync-artifacts-catalog.ts <dockerfile> <catalog>`
 */

import { slimCatalogPin } from "../../apps/cli/src/shared/services/slim-images.ts";
import {
  DIGEST_PATTERN,
  InvalidPayloadError,
  SOURCE_REGISTRY,
  VERSION_PATTERN,
  escapeRegExp,
} from "./slim-mirror-payload.ts";

export const CATALOG_PATH = "packages/stack/src/Artifacts.ts";
const DOCKERFILE_PATH = "apps/cli/src/shared/services/Dockerfile";

const SLIM_IMAGE_PREFIX = `${SOURCE_REGISTRY}/`;

// Same FROM shape as `parseDockerfileServiceImages` in dockerfile-images.ts.
const FROM_LINE_PATTERN = /^FROM\s+(.+):([^:\s]+)\s+AS\s+([^\s#]+)/i;

function parseDockerfileServiceImages(
  dockerfile: string,
): ReadonlyArray<{ readonly alias: string; readonly image: string }> {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = FROM_LINE_PATTERN.exec(line);
      if (match === null) return [];
      const [, repository, tag, alias] = match;
      if (repository === undefined || tag === undefined || alias === undefined) return [];
      return [{ alias, image: `${repository}:${tag}` }];
    });
}

/** Leading numeric component, `v` stripped. Only postgres carries more than one line. */
export function releaseLine(version: string): string {
  const withoutPrefix = version.replace(/^[vV]/, "");
  const separator = withoutPrefix.indexOf(".");
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

export interface CatalogPinUpdate {
  readonly service: string;
  readonly version: string;
  readonly previousVersion: string;
  readonly target: "default" | "additional";
}

export interface CatalogPlan {
  readonly source: string;
  readonly updates: ReadonlyArray<CatalogPinUpdate>;
}

interface DockerfilePin {
  readonly alias: string;
  readonly service: string;
  readonly version: string;
}

/** `definition("<service>", "<version>", "<image>"`. */
function defaultEntryPattern(service: string): RegExp {
  const s = escapeRegExp(service);
  return new RegExp(
    `(definition\\(\\s*"${s}",\\s*")([^"]+)("\\s*,\\s*")(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)(")`,
  );
}

/** Additional release entries: `"<version>": "<image>"`. */
function additionalEntryPattern(service: string, version?: string): RegExp {
  const s = escapeRegExp(service);
  const key = version === undefined ? `[^"]+` : escapeRegExp(version);
  return new RegExp(
    `"(${key})"(\\s*:\\s*)"(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)"`,
    version === undefined ? "g" : "",
  );
}

function imageHasDigest(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image);
}

function desiredImage(
  service: string,
  version: string,
  currentImage: string,
  digest: string | undefined,
): string {
  const tagged = `${SLIM_IMAGE_PREFIX}${service}:${version}`;
  if (!imageHasDigest(currentImage)) return tagged;
  if (digest === undefined || !DIGEST_PATTERN.test(digest)) {
    throw new InvalidPayloadError(`missing slim digest for ${service}:${version}`);
  }
  return `${tagged}@${digest}`;
}

type SelectedEntry =
  | { readonly kind: "default" | "additional"; readonly version: string; readonly image: string }
  | { readonly kind: "unmodelled-service" }
  | { readonly kind: "unmodelled-release-line"; readonly known: ReadonlyArray<string> };

function selectEntry(source: string, service: string, version: string): SelectedEntry {
  const defaultMatch = defaultEntryPattern(service).exec(source);
  if (defaultMatch === null) return { kind: "unmodelled-service" };

  const currentDefaultVersion = defaultMatch[2] ?? "";
  const currentDefaultImage = defaultMatch[4] ?? "";
  const additional = [...source.matchAll(additionalEntryPattern(service))].map((match) => ({
    version: match[1] ?? "",
    image: match[3] ?? "",
  }));
  const bumpsDefault =
    additional.length === 0 || releaseLine(version) === releaseLine(currentDefaultVersion);
  if (bumpsDefault) {
    return { kind: "default", version: currentDefaultVersion, image: currentDefaultImage };
  }

  const sameLine = additional.find((entry) => releaseLine(entry.version) === releaseLine(version));
  if (sameLine === undefined) {
    return {
      kind: "unmodelled-release-line",
      known: [currentDefaultVersion, ...additional.map((entry) => entry.version)],
    };
  }
  return { kind: "additional", version: sameLine.version, image: sameLine.image };
}

function dockerfilePins(dockerfile: string): ReadonlyArray<DockerfilePin> {
  const pins: DockerfilePin[] = [];
  for (const from of parseDockerfileServiceImages(dockerfile)) {
    const pin = slimCatalogPin(from.alias, from.image);
    if (pin === undefined) continue;
    if (!VERSION_PATTERN.test(pin.version)) {
      throw new InvalidPayloadError(`invalid version for ${from.alias}: '${pin.version}'`);
    }
    pins.push({ alias: from.alias, service: pin.service, version: pin.version });
  }
  return pins;
}

function rejectUnmodelled(
  alias: string,
  service: string,
  version: string,
  entry: SelectedEntry,
): void {
  if (entry.kind === "unmodelled-service") {
    throw new InvalidPayloadError(
      `${CATALOG_PATH} has no ${service} entry for the ${alias} image.`,
    );
  }
  if (entry.kind === "unmodelled-release-line") {
    throw new InvalidPayloadError(
      `${service} ${version} is not on a release line ${CATALOG_PATH} carries (${entry.known.join(", ")}).`,
    );
  }
}

/** Slim tags whose catalog entry stores a digest, so the rewrite can resolve them first. */
export function catalogDigestPins(
  dockerfile: string,
  catalog: string,
): ReadonlyArray<{ readonly service: string; readonly version: string }> {
  const pins: Array<{ service: string; version: string }> = [];
  for (const pin of dockerfilePins(dockerfile)) {
    const entry = selectEntry(catalog, pin.service, pin.version);
    rejectUnmodelled(pin.alias, pin.service, pin.version, entry);
    if (entry.kind !== "default" && entry.kind !== "additional") continue;
    if (imageHasDigest(entry.image)) pins.push({ service: pin.service, version: pin.version });
  }
  return pins;
}

type PinResult =
  | {
      readonly kind: "updated";
      readonly source: string;
      readonly previousVersion: string;
      readonly target: "default" | "additional";
    }
  | { readonly kind: "unchanged" };

function pinService(
  source: string,
  service: string,
  version: string,
  digest: string | undefined,
): PinResult {
  const entry = selectEntry(source, service, version);
  if (entry.kind !== "default" && entry.kind !== "additional") {
    throw new InvalidPayloadError(`${service} ${version} is not a catalog entry.`);
  }
  const desired = desiredImage(service, version, entry.image, digest);
  if (entry.version === version && entry.image === desired) return { kind: "unchanged" };

  if (entry.kind === "default") {
    return {
      kind: "updated",
      source: source.replace(
        defaultEntryPattern(service),
        (_full, prefix: string, _version: string, mid: string, _image: string, suffix: string) =>
          `${prefix}${version}${mid}${desired}${suffix}`,
      ),
      previousVersion: entry.version,
      target: "default",
    };
  }

  return {
    kind: "updated",
    source: source.replace(
      additionalEntryPattern(service, entry.version),
      (_full, _key: string, separator: string) => `"${version}"${separator}"${desired}"`,
    ),
    previousVersion: entry.version,
    target: "additional",
  };
}

/**
 * Rewrites `catalog` so every slim Dockerfile pin matches. Aliases with no slim
 * build are skipped. A modelled service on an unknown release line throws:
 * the docker.io tag and the catalog would otherwise diverge.
 */
export function planArtifactCatalogUpdate(input: {
  readonly dockerfile: string;
  readonly catalog: string;
  readonly digestFor: (service: string, version: string) => string;
}): CatalogPlan {
  let source = input.catalog;
  const updates: CatalogPinUpdate[] = [];

  for (const pin of dockerfilePins(input.dockerfile)) {
    const entry = selectEntry(source, pin.service, pin.version);
    rejectUnmodelled(pin.alias, pin.service, pin.version, entry);
    if (entry.kind !== "default" && entry.kind !== "additional") continue;
    const digest = imageHasDigest(entry.image)
      ? input.digestFor(pin.service, pin.version)
      : undefined;
    const result = pinService(source, pin.service, pin.version, digest);
    if (result.kind === "unchanged") continue;
    source = result.source;
    updates.push({
      service: pin.service,
      version: pin.version,
      previousVersion: result.previousVersion,
      target: result.target,
    });
  }

  return { source, updates };
}

async function publishedDigest(service: string, version: string): Promise<string> {
  const reference = `${SLIM_IMAGE_PREFIX}${service}:${version}`;
  const proc = Bun.spawn(["regctl", "manifest", "head", reference], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const live = stdout.trim();
  if (exit !== 0 || !DIGEST_PATTERN.test(live)) {
    const detail = stderr.trim();
    throw new InvalidPayloadError(
      `${reference} has no slim manifest digest${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return live;
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const [dockerfilePath = DOCKERFILE_PATH, catalogPath = CATALOG_PATH] = argv;
  const dockerfile = await Bun.file(dockerfilePath).text();
  const catalog = await Bun.file(catalogPath).text();
  const digests = new Map<string, string>();
  for (const pin of catalogDigestPins(dockerfile, catalog)) {
    const key = `${pin.service}:${pin.version}`;
    if (!digests.has(key)) digests.set(key, await publishedDigest(pin.service, pin.version));
  }

  const plan = planArtifactCatalogUpdate({
    dockerfile,
    catalog,
    digestFor: (service, version) => {
      const digest = digests.get(`${service}:${version}`);
      if (digest === undefined) {
        throw new InvalidPayloadError(`missing slim digest for ${service}:${version}`);
      }
      return digest;
    },
  });
  await Bun.write(catalogPath, plan.source);
  if (plan.updates.length === 0) {
    console.log("Workload catalog already matches the Dockerfile.");
    return;
  }
  for (const update of plan.updates) {
    console.log(
      `Pinned ${update.service} ${update.target} ${update.previousVersion} -> ${update.version}.`,
    );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
