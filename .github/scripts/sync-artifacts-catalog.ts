/**
 * Pins `packages/stack/src/Artifacts.ts` to the slim workloads named by
 * `apps/cli/src/shared/services/Dockerfile`. Native archive URLs are derived
 * from service + version. An entry that already carries a digest keeps one:
 * the published `ghcr.io/supabase/cli/<service>:<version>` manifest digest.
 * A pin is refused until ECR Public serves the same digest, so the stack's
 * image fallback can pull it.
 *
 * Run: `bun .github/scripts/sync-artifacts-catalog.ts <dockerfile> <catalog> [base-dockerfile]`
 */

import { parseDockerfileServiceImages } from "../../apps/cli/src/shared/services/parse-dockerfile-service-images.ts";
import { isOrioleImage, slimCatalogPin } from "../../apps/cli/src/shared/services/slim-images.ts";
import {
  DEST_REGISTRY,
  DIGEST_PATTERN,
  InvalidPayloadError,
  SOURCE_REGISTRY,
  VERSION_PATTERN,
  escapeRegExp,
} from "./slim-mirror-payload.ts";

export const CATALOG_PATH = "packages/stack/src/Artifacts.ts";
const DOCKERFILE_PATH = "apps/cli/src/shared/services/Dockerfile";
const NATIVE_RELEASES = "https://api.github.com/repos/supabase/slim-services/releases/tags";

const SLIM_IMAGE_PREFIX = `${SOURCE_REGISTRY}/`;

/** Leading numeric component, `v` stripped. Only postgres carries more than one line. */
function releaseLine(version: string): string {
  const withoutPrefix = version.replace(/^[vV]/, "");
  const separator = withoutPrefix.indexOf(".");
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

/** True when every numeric prefix of `next` is older than `current`. Equal prefixes are not older. */
function isOlderRelease(next: string, current: string): boolean {
  const nextParts = next.replace(/^[vV]/, "").split(".");
  const currentParts = current.replace(/^[vV]/, "").split(".");
  const count = Math.max(nextParts.length, currentParts.length);
  for (let index = 0; index < count; index++) {
    const nextValue = leadingInteger(nextParts[index] ?? "0");
    const currentValue = leadingInteger(currentParts[index] ?? "0");
    if (nextValue === undefined || currentValue === undefined) return false;
    if (nextValue !== currentValue) return nextValue < currentValue;
  }
  return false;
}

function leadingInteger(part: string): number | undefined {
  const match = /^(\d+)/.exec(part);
  return match === null ? undefined : Number(match[1]);
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
  /** OrioleDB has no slim image and must not fail the other pins. */
  readonly blocking: boolean;
}

export interface CatalogPlan {
  readonly source: string;
  readonly updates: ReadonlyArray<CatalogPinUpdate>;
  readonly skipped: ReadonlyArray<SkippedCatalogPin>;
}

export type ReleasePublication =
  | { readonly status: "published"; readonly digest?: string }
  | { readonly status: "missing" | "unmirrored" | "lookup-failed" };

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

function slimVersions(dockerfile: string): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const from of parseDockerfileServiceImages(dockerfile)) {
    const pin = slimCatalogPin(from.alias, from.image);
    if (pin !== undefined) versions.set(from.alias, pin.version);
  }
  return versions;
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
 * Rewrites `catalog` from Dockerfile tags that differ from `baseDockerfile`.
 * With no base, every slim tag is in scope. A pin that cannot be applied is
 * reported in `skipped`. OrioleDB is the only non-blocking skip.
 */
export async function planArtifactCatalogUpdate(input: {
  readonly dockerfile: string;
  readonly baseDockerfile?: string;
  readonly catalog: string;
  readonly publication: (service: string, version: string) => Promise<ReleasePublication>;
}): Promise<CatalogPlan> {
  let source = input.catalog;
  const updates: CatalogPinUpdate[] = [];
  const skipped: SkippedCatalogPin[] = [];
  const baseVersions =
    input.baseDockerfile === undefined ? undefined : slimVersions(input.baseDockerfile);
  const changed = (alias: string, version: string | undefined): boolean =>
    baseVersions === undefined || baseVersions.get(alias) !== version;

  for (const from of parseDockerfileServiceImages(input.dockerfile)) {
    if (isOrioleImage(from.image)) {
      if (!changed(from.alias, undefined)) continue;
      skipped.push({
        alias: from.alias,
        reason: `${from.alias} ${from.image} has no slim image.`,
        blocking: false,
      });
      continue;
    }
    const pin = slimCatalogPin(from.alias, from.image);
    if (pin === undefined || !changed(from.alias, pin.version)) continue;
    if (!VERSION_PATTERN.test(pin.version)) {
      throw new InvalidPayloadError(`invalid version for ${from.alias}: '${pin.version}'`);
    }

    const entry = selectEntry(source, pin.service, pin.version);
    const reason = skipReason(from.alias, pin.version, entry);
    if (reason !== undefined) {
      skipped.push({ alias: from.alias, reason, blocking: true });
      continue;
    }
    if (entry.kind !== "default" && entry.kind !== "additional") continue;
    if (isOlderRelease(pin.version, entry.version)) {
      skipped.push({
        alias: from.alias,
        reason: `${pin.service} ${pin.version} is older than the catalog pin ${entry.version}.`,
        blocking: true,
      });
      continue;
    }
    if (entry.version === pin.version && !imageHasDigest(entry.image)) continue;

    const release = await input.publication(pin.service, pin.version);
    if (release.status !== "published") {
      skipped.push({
        alias: from.alias,
        reason:
          release.status === "missing"
            ? `${pin.service}:${pin.version} has no published slim image and native release.`
            : release.status === "unmirrored"
              ? `${pin.service}:${pin.version} on ${DEST_REGISTRY} does not match the GHCR digest.`
              : `${pin.service}:${pin.version} publication check failed.`,
        blocking: true,
      });
      continue;
    }
    const digest = imageHasDigest(entry.image) ? release.digest : undefined;
    if (imageHasDigest(entry.image) && (digest === undefined || !DIGEST_PATTERN.test(digest))) {
      skipped.push({
        alias: from.alias,
        reason: `${pin.service}:${pin.version} has no published slim manifest.`,
        blocking: true,
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

type Probe = "published" | "missing" | "lookup-failed";

async function probeManifest(reference: string): Promise<{ probe: Probe; digest?: string }> {
  const proc = Bun.spawn(["regctl", "manifest", "head", reference], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const digest = stdout.trim();
  if (exit === 0 && DIGEST_PATTERN.test(digest)) return { probe: "published", digest };
  const detail = stderr.toLowerCase();
  if (
    detail.includes("manifest unknown") ||
    detail.includes("name unknown") ||
    detail.includes("not found") ||
    detail.includes("404")
  ) {
    return { probe: "missing" };
  }
  const message = stderr.trim();
  console.log(
    `::warning ::${reference} publication check failed${message === "" ? "" : `: ${message}`}`,
  );
  return { probe: "lookup-failed" };
}

async function probeNativeRelease(service: string, version: string): Promise<Probe> {
  const tag = `${service}-${version}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "supabase-cli-catalog-sync",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token !== "") headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${NATIVE_RELEASES}/${encodeURIComponent(tag)}`, { headers });
    if (response.status === 200) return "published";
    if (response.status === 404) return "missing";
    console.log(`::warning ::${tag} native release check returned HTTP ${response.status}.`);
    return "lookup-failed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning ::${tag} native release check failed: ${message}`);
    return "lookup-failed";
  }
}

async function lookupPublication(service: string, version: string): Promise<ReleasePublication> {
  const [manifest, mirror, native] = await Promise.all([
    probeManifest(`${SLIM_IMAGE_PREFIX}${service}:${version}`),
    probeManifest(`${DEST_REGISTRY}/${service}:${version}`),
    probeNativeRelease(service, version),
  ]);
  if (manifest.probe === "lookup-failed" || native === "lookup-failed") {
    return { status: "lookup-failed" };
  }
  if (manifest.probe === "missing" || native === "missing") return { status: "missing" };
  if (mirror.probe === "lookup-failed") return { status: "lookup-failed" };
  if (mirror.digest !== manifest.digest) return { status: "unmirrored" };
  return { status: "published", digest: manifest.digest };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const [dockerfilePath = DOCKERFILE_PATH, catalogPath = CATALOG_PATH, baseDockerfilePath] = argv;
  const dockerfile = await Bun.file(dockerfilePath).text();
  const catalog = await Bun.file(catalogPath).text();
  const baseDockerfile =
    baseDockerfilePath === undefined ? undefined : await Bun.file(baseDockerfilePath).text();
  const plan = await planArtifactCatalogUpdate({
    dockerfile,
    baseDockerfile,
    catalog,
    publication: lookupPublication,
  });
  for (const skip of plan.skipped) {
    console.log(`::warning ::Left ${skip.alias} unchanged: ${skip.reason}`);
  }
  if (plan.skipped.some((skip) => skip.blocking)) {
    console.log("::error ::Refusing to commit a partial catalog update.");
    process.exit(1);
  }
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
