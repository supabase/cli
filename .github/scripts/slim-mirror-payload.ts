/**
 * Untrusted `mirror-slim-image` dispatch fields. Source and destination URLs
 * are derived here; payload strings are only accepted when they match.
 */

export const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/;
export const VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const SOURCE_REGISTRY = "ghcr.io/supabase/cli";
export const DEST_REGISTRY = "public.ecr.aws/supabase/cli";
export const NATIVE_TARGETS = ["linux-arm64", "linux-amd64", "darwin-arm64"] as const;

export class InvalidPayloadError extends Error {}

export const imageSource = (service: string, version: string): string =>
  `${SOURCE_REGISTRY}/${service}:${version}`;

export const imageDestination = (service: string, version: string): string =>
  `${DEST_REGISTRY}/${service}:${version}`;

export const digestReference = (tagged: string, digest: string): string => {
  const colon = tagged.lastIndexOf(":");
  if (colon <= 0) throw new InvalidPayloadError(`invalid image reference: ${tagged}`);
  return `${tagged.slice(0, colon)}@${digest}`;
};

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
