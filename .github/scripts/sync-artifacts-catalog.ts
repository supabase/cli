/**
 * Pins `packages/stack/src/Artifacts.ts` to the slim workloads named by
 * `apps/cli/src/shared/services/Dockerfile`. Native archive URLs are derived
 * from service + version. An entry that already carries a digest keeps one:
 * the published `ghcr.io/supabase/cli/<service>:<version>` manifest digest.
 *
 * Run: `bun .github/scripts/sync-artifacts-catalog.ts <dockerfile> <catalog>`
 */

import { parseDockerfileServiceImages } from "../../apps/cli/src/shared/services/parse-dockerfile-service-images.ts";
import { isOrioleImage, slimCatalogPin } from "../../apps/cli/src/shared/services/slim-images.ts";
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

export interface SkippedCatalogPin {
  readonly alias: string;
  readonly reason: string;
}

export interface CatalogPlan {
  readonly source: string;
  readonly updates: ReadonlyArray<CatalogPinUpdate>;
  readonly skipped: ReadonlyArray<SkippedCatalogPin>;
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
  digest: string,
): string {
  const tagged = `${SLIM_IMAGE_PREFIX}${service}:${version}`;
  if (!imageHasDigest(currentImage)) return tagged;
  if (!DIGEST_PATTERN.test(digest)) {
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

function skipReason(alias: string, version: string, entry: SelectedEntry): string | undefined {
  if (entry.kind === "unmodelled-service") {
    return `${CATALOG_PATH} has no slim entry for ${alias}.`;
  }
  if (entry.kind === "unmodelled-release-line") {
    return `${alias} ${version} is not on a release line ${CATALOG_PATH} carries (${entry.known.join(", ")}).`;
  }
  return undefined;
}

/** Slim tags whose catalog entry stores a digest, so the rewrite can resolve them first. */
export function catalogDigestPins(
  dockerfile: string,
  catalog: string,
): ReadonlyArray<{ readonly service: string; readonly version: string }> {
  const pins: Array<{ service: string; version: string }> = [];
  for (const from of parseDockerfileServiceImages(dockerfile)) {
    const pin = slimCatalogPin(from.alias, from.image);
    if (pin === undefined || !VERSION_PATTERN.test(pin.version)) continue;
    const entry = selectEntry(catalog, pin.service, pin.version);
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
  if (imageHasDigest(entry.image) && (digest === undefined || !DIGEST_PATTERN.test(digest))) {
    throw new InvalidPayloadError(`missing slim digest for ${service}:${version}`);
  }
  const desired = desiredImage(service, version, entry.image, digest ?? "");
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
 * Rewrites `catalog` from the service-image Dockerfile. OrioleDB tags and other
 * images with no slim build are left unchanged. A pin that cannot be applied
 * is reported in `skipped` and does not stop the remaining pins.
 */
export function planArtifactCatalogUpdate(input: {
  readonly dockerfile: string;
  readonly catalog: string;
  readonly digestFor: (service: string, version: string) => string | undefined;
}): CatalogPlan {
  let source = input.catalog;
  const updates: CatalogPinUpdate[] = [];
  const skipped: SkippedCatalogPin[] = [];

  for (const from of parseDockerfileServiceImages(input.dockerfile)) {
    if (isOrioleImage(from.image)) {
      skipped.push({
        alias: from.alias,
        reason: `${from.alias} ${from.image} has no slim image.`,
      });
      continue;
    }
    const pin = slimCatalogPin(from.alias, from.image);
    if (pin === undefined) continue;
    if (!VERSION_PATTERN.test(pin.version)) {
      throw new InvalidPayloadError(`invalid version for ${from.alias}: '${pin.version}'`);
    }

    const entry = selectEntry(source, pin.service, pin.version);
    const reason = skipReason(from.alias, pin.version, entry);
    if (reason !== undefined) {
      skipped.push({ alias: from.alias, reason });
      continue;
    }
    if (entry.kind !== "default" && entry.kind !== "additional") continue;
    const digest = imageHasDigest(entry.image)
      ? input.digestFor(pin.service, pin.version)
      : undefined;
    if (imageHasDigest(entry.image) && digest === undefined) {
      skipped.push({
        alias: from.alias,
        reason: `${pin.service}:${pin.version} has no published slim manifest.`,
      });
      continue;
    }
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

  return { source, updates, skipped };
}

async function publishedDigest(service: string, version: string): Promise<string | undefined> {
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
    console.log(
      `::warning ::${reference} has no slim manifest digest${detail === "" ? "" : `: ${detail}`}`,
    );
    return undefined;
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
    if (!digests.has(key)) {
      const digest = await publishedDigest(pin.service, pin.version);
      if (digest !== undefined) digests.set(key, digest);
    }
  }

  const plan = planArtifactCatalogUpdate({
    dockerfile,
    catalog,
    digestFor: (service, version) => digests.get(`${service}:${version}`),
  });
  await Bun.write(catalogPath, plan.source);
  for (const skip of plan.skipped) {
    console.log(`::warning ::Left ${skip.alias} unchanged: ${skip.reason}`);
  }
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
