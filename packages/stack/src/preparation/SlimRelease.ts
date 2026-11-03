/**
 * Slim-services release conventions shared by the stack's release resolver and the catalog sync
 * scripts under `.github/scripts`. Dependency-free so both can import it.
 */

/** Native targets every slim release publishes, in catalog serialization order. */
export const NATIVE_TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;

export type SlimNativeTarget = (typeof NATIVE_TARGETS)[number];

/** Producers that mirror an unmodified upstream image: its provenance file names it, not a manifest. */
export const MIRROR_PRODUCERS: ReadonlySet<string> = new Set(["vector", "mailpit", "imgproxy"]);

/**
 * A normalized upstream image: lowercase `[a-z0-9]` path segments optionally separated by
 * `.`/`_`/`-`, a `:`, and a tag in Docker's grammar. Anchored, so the value can be embedded in
 * generated source.
 */
export const UPSTREAM_IMAGE_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

/** Strips a `docker.io/` prefix and any `@sha256:…` digest. */
export const normalizeUpstreamImage = (image: string): string => {
  const withoutDigest = image.split("@")[0] ?? image;
  return withoutDigest.startsWith("docker.io/")
    ? withoutDigest.slice("docker.io/".length)
    : withoutDigest;
};

const SUMS_LINE = /^([0-9a-f]{64})[ \t]+\*?(.+)$/iu;

export type ParsedSums =
  | { readonly kind: "sums"; readonly sums: ReadonlyMap<string, string> }
  | {
      readonly kind: "malformed";
      readonly message: string;
      readonly expected?: string;
      readonly actual?: string;
    };

/**
 * Parses a release `SHA256SUMS` into lowercase digests keyed by asset basename. Rejects a line
 * that is not `<sha256>  <name>` and a name listed with two different digests.
 */
export const parseSha256Sums = (text: string): ParsedSums => {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = SUMS_LINE.exec(trimmed);
    if (match === null)
      return { kind: "malformed", message: "SHA256SUMS contains a malformed line" };
    const name = (match[2] ?? "").split("/").at(-1) ?? "";
    const digest = (match[1] ?? "").toLowerCase();
    const known = sums.get(name);
    if (known !== undefined && known !== digest)
      return {
        kind: "malformed",
        message: `SHA256SUMS lists ${name} with two digests`,
        expected: known,
        actual: digest,
      };
    sums.set(name, digest);
  }
  return { kind: "sums", sums };
};
