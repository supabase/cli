/**
 * Untrusted `mirror-slim-image` dispatch fields. Source and destination URLs
 * are derived here; payload strings are only accepted when they match.
 */

const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/;
export const VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const SOURCE_REGISTRY = "ghcr.io/supabase/cli";
export const DEST_REGISTRY = "public.ecr.aws/supabase/cli";
const NATIVE_TARGETS = ["linux-arm64", "linux-amd64", "darwin-arm64"] as const;

export class InvalidPayloadError extends Error {}

const imageSource = (service: string, version: string): string =>
  `${SOURCE_REGISTRY}/${service}:${version}`;

const imageDestination = (service: string, version: string): string =>
  `${DEST_REGISTRY}/${service}:${version}`;

export const digestReference = (tagged: string, digest: string): string => {
  const colon = tagged.lastIndexOf(":");
  if (colon <= 0) throw new InvalidPayloadError(`invalid image reference: ${tagged}`);
  return `${tagged.slice(0, colon)}@${digest}`;
};

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const nativeTagPattern = (version: string): RegExp =>
  new RegExp(`^${escapeRegExp(version)}-native-(${NATIVE_TARGETS.join("|")})$`);

/** `service` / `version` / `digest` are the image fields. Extra keys such as `natives[]` are ignored. */
export const validatePayload = (input: {
  readonly service: string;
  readonly version: string;
  readonly digest: string;
}): void => {
  if (!SERVICE_PATTERN.test(input.service))
    throw new InvalidPayloadError(`invalid service name: '${input.service}'`);
  if (!VERSION_PATTERN.test(input.version))
    throw new InvalidPayloadError(`invalid version: '${input.version}'`);
  if (!DIGEST_PATTERN.test(input.digest))
    throw new InvalidPayloadError(`invalid digest: '${input.digest}'`);
};

export type MirrorRefs = {
  readonly service: string;
  readonly version: string;
  readonly digest: string;
  readonly source: string;
  readonly destination: string;
};

export const validateMirrorDispatch = (input: {
  readonly eventName: string;
  readonly service: string;
  readonly version: string;
  readonly digest: string;
  readonly payloadSource: string | undefined;
  readonly payloadDestination: string | undefined;
}): MirrorRefs => {
  validatePayload(input);
  const source = imageSource(input.service, input.version);
  const destination = imageDestination(input.service, input.version);
  if (input.eventName === "repository_dispatch") {
    if (input.payloadSource !== source)
      throw new InvalidPayloadError(
        `payload source '${input.payloadSource}' does not match derived '${source}'`,
      );
    if (input.payloadDestination !== destination)
      throw new InvalidPayloadError(
        `payload destination '${input.payloadDestination}' does not match derived '${destination}'`,
      );
  }
  return {
    service: input.service,
    version: input.version,
    digest: input.digest,
    source,
    destination,
  };
};

export type NativeArtifact = {
  readonly tag: string;
  readonly digest: string;
};

export const parseNatives = (raw: unknown, version: string): ReadonlyArray<NativeArtifact> => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidPayloadError("natives must be a JSON array");
  const tagRe = nativeTagPattern(version);
  const rows: NativeArtifact[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || !("tag" in item) || !("digest" in item))
      throw new InvalidPayloadError(`invalid native entry: ${JSON.stringify(item)}`);
    const tag = (item as { tag: unknown }).tag;
    const digest = (item as { digest: unknown }).digest;
    if (typeof tag !== "string" || !tagRe.test(tag))
      throw new InvalidPayloadError(`invalid native tag: ${String(tag)}`);
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest))
      throw new InvalidPayloadError(`invalid native digest: ${String(digest)}`);
    rows.push({ tag, digest });
  }
  return rows;
};

export const S3_BUCKET = "supabase-cli-artifacts";
export const S3_BASE_URL = `https://${S3_BUCKET}.s3.us-east-1.amazonaws.com`;

const ARCHIVE_MEDIA_TYPE = "application/vnd.supabase.slim.archive.v1.tar+zstd";
const MANIFEST_MEDIA_TYPE = "application/vnd.supabase.slim.manifest.v1+json";
const CHECKSUM_MEDIA_TYPE = "application/vnd.supabase.slim.checksum.v1";

type NativeTarget = (typeof NATIVE_TARGETS)[number];

export const nativeTargetOf = (tag: string, version: string): NativeTarget | undefined => {
  const match = nativeTagPattern(version).exec(tag);
  return match === null ? undefined : (match[1] as NativeTarget);
};

/** Release asset stem shared by GitHub Releases, the OCI triplet, and the S3 mirror. */
const nativeAssetName = (service: string, version: string, target: string): string =>
  `${service}-${version}-${target}`;

export type NativeFiles = {
  readonly archive: string;
  readonly manifest: string;
  readonly checksum: string;
};

export const nativeFileNames = (service: string, version: string, target: string): NativeFiles => {
  const stem = nativeAssetName(service, version, target);
  return {
    archive: `${stem}.tar.zst`,
    manifest: `${stem}.manifest.json`,
    checksum: `${stem}.SHA256SUMS`,
  };
};

export const nativeObjectKey = (service: string, version: string, fileName: string): string =>
  `${service}/${version}/${fileName}`;

export const nativeObjectUrl = (service: string, version: string, fileName: string): string =>
  `${S3_BASE_URL}/${nativeObjectKey(service, version, fileName)}`;

type OciLayer = {
  readonly mediaType: string;
  readonly digest: string;
  readonly title: string;
};

// Registry and blob contents are untrusted input; malformed JSON drops one target, not the run.
const parseJsonRecord = (raw: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
};

const layersOf = (rawManifest: string): ReadonlyArray<OciLayer> => {
  const record = parseJsonRecord(rawManifest);
  if (record === undefined) return [];
  const raw = record["layers"] ?? record["blobs"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const layer = entry as Record<string, unknown>;
    const digest = typeof layer["digest"] === "string" ? layer["digest"] : "";
    if (!DIGEST_PATTERN.test(digest)) return [];
    const annotations =
      typeof layer["annotations"] === "object" && layer["annotations"] !== null
        ? (layer["annotations"] as Record<string, unknown>)
        : {};
    const title = annotations["org.opencontainers.image.title"];
    return [
      {
        mediaType: typeof layer["mediaType"] === "string" ? layer["mediaType"] : "",
        digest,
        title: typeof title === "string" ? title : "",
      },
    ];
  });
};

/** Blob digests of the native triplet inside an OCI artifact manifest, or undefined when incomplete. */
export const nativeTripletDigests = (rawManifest: string): NativeFiles | undefined => {
  const layers = layersOf(rawManifest);
  const archive = layers.find(
    (layer) => layer.mediaType === ARCHIVE_MEDIA_TYPE || layer.title.endsWith(".tar.zst"),
  );
  const manifest = layers.find(
    (layer) => layer.mediaType === MANIFEST_MEDIA_TYPE || layer.title.endsWith(".manifest.json"),
  );
  const checksum = layers.find(
    (layer) => layer.mediaType === CHECKSUM_MEDIA_TYPE || layer.title.endsWith(".SHA256SUMS"),
  );
  if (archive === undefined || manifest === undefined || checksum === undefined) return undefined;
  return {
    archive: archive.digest,
    manifest: manifest.digest,
    checksum: checksum.digest,
  };
};

export const checksumFor = (contents: string, archiveName: string): string | undefined =>
  contents
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/iu))
    .find((match) => match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`))?.[1]
    ?.toLowerCase();

export const manifestMatches = (
  manifestJson: string,
  expected: {
    readonly service: string;
    readonly version: string;
    readonly target: string;
  },
): boolean => {
  const record = parseJsonRecord(manifestJson);
  if (record === undefined) return false;
  return (
    record["service"] === expected.service &&
    record["version"] === expected.version &&
    record["target"] === expected.target
  );
};
