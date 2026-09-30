/**
 * Pins `packages/stack/src/Artifacts.ts` to committed `supabase/slim-services`
 * revisions (`<upstream>-r<N>`). Every entry is pinned by content: the GHCR
 * image digest, plus an archive and manifest sha256 per native target.
 *
 * The catalog is the single version table (supabase/cli#6883): the Dockerfile's
 * slim-capable lines are a generated view of it
 * (`apps/cli/scripts/render-service-dockerfile.ts`), never the other way
 * around. Updates land through two modes:
 *
 * Manual mode: refreshes one catalog entry, either to a specific committed
 * release (`--release`) or to the highest committed revision of a given
 * upstream version, or of its currently pinned upstream version when neither
 * is given. `--upstream` and `--release` are mutually exclusive.
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts --service <service> [--upstream <U> | --release <U>-r<N>]
 *
 * Plan-updates mode (used by the `slim-release-published` dispatch workflow):
 * lists a service's committed slim-services releases and computes, per
 * release line, the hotfix and/or upgrade a workflow should apply. Pure
 * planning: `planSlimUpdates` takes the release tag list as an argument,
 * makes no network calls, and never logs — it returns `{ updates, warnings }`.
 * Records go only to `--output <path>` (never stdout); warnings print to
 * stdout as `::warning ::…` lines, so the two channels can't corrupt one
 * another when a caller redirects stdout separately from the records file.
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts plan-updates --service <service> \
 *     --output <path> [--format lines] [--expect-release <U>-r<N>]
 *
 * `--expect-release` handles the releases API lagging behind the dispatch that triggered this
 * run: before planning, the listed committed tags must include `<service>-<release_version>`, or
 * this mode re-lists a bounded number of times before giving up (`waitForExpectedRelease`).
 *
 * Validate-payload mode (used by the same workflow, before anything else):
 * checks an untrusted `slim-release-published` dispatch payload against
 * anchored charsets and prints it back as `key=value` lines, so a value that
 * fails validation is never written to `$GITHUB_OUTPUT` in the first place.
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts validate-payload --service <service> \
 *     --upstream <U> --revision <N> --release <R>
 */

import {
  DIGEST_PATTERN,
  InvalidPayloadError,
  SOURCE_REGISTRY,
  checksumFor,
  escapeRegExp,
  nativeFileNames,
  nativeObjectUrl,
} from "./slim-mirror-payload.ts";

export const CATALOG_PATH = "packages/stack/src/Artifacts.ts";

const SLIM_IMAGE_PREFIX = `${SOURCE_REGISTRY}/`;

/** The three native targets the catalog pins per revision. Kept self-contained; see module docs. */
const NATIVE_TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;
type NativeTargetName = (typeof NATIVE_TARGETS)[number];

/** Overridable so an integration test can point at a local fixture server instead of GitHub. */
const RELEASES_API =
  process.env.SLIM_SERVICES_RELEASES_API ??
  "https://api.github.com/repos/supabase/slim-services/releases";
const RELEASE_DOWNLOAD_BASE = "https://github.com/supabase/slim-services/releases/download";

/** Bounded retry for `waitForExpectedRelease`: 6 attempts, 10s apart, by default. */
const EXPECT_RELEASE_ATTEMPTS = 6;
const DEFAULT_EXPECT_RELEASE_INTERVAL_MS = 10_000;
/** Bounded retry for the S3-mirror wait in `resolveRevisionPin`: ~10 min, covering a native upload of all three targets (`mirror-slim-image.yml`'s `upload-natives-s3`). */
const S3_WAIT_ATTEMPTS = 20;
const DEFAULT_S3_WAIT_INTERVAL_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1; // setTimeout's own ceiling.

/**
 * Parses a millisecond wait-interval override from `envVar` fresh on every call, not once at
 * module load, so a test can set it right before spawning. Unset keeps `fallback`; anything else
 * must be a non-negative integer of at most `MAX_TIMER_DELAY_MS`, or this throws.
 */
function waitIntervalMs(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || value > MAX_TIMER_DELAY_MS) {
    throw new InvalidPayloadError(
      `invalid ${envVar} ${JSON.stringify(raw)}: expected a non-negative integer of at most ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return value;
}

const expectReleaseIntervalMs = (): number =>
  waitIntervalMs("SLIM_UPDATES_EXPECT_RELEASE_WAIT_MS", DEFAULT_EXPECT_RELEASE_INTERVAL_MS);
const s3WaitIntervalMs = (): number =>
  waitIntervalMs("SLIM_UPDATES_S3_WAIT_MS", DEFAULT_S3_WAIT_INTERVAL_MS);

/** Real delay, for a caller that didn't override `wait`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BoundedCheck<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "retry" }
  | { readonly kind: "failed"; readonly message: string };

type BoundedWaitOutcome<T> =
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "timed-out" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Generic bounded retry-with-wait: `waitForExpectedRelease`'s release-visibility wait and
 * `resolveRevisionPin`'s S3-mirror wait both build on this. Calls `check` up to `attempts`
 * times, `wait`-ing `intervalMs` between, until it reports `"done"` or an unrecoverable
 * `"failed"` (never waited out). Exhausting every attempt on `"retry"` yields `"timed-out"`.
 */
async function boundedWait<T>(
  check: () => Promise<BoundedCheck<T>>,
  wait: (ms: number) => Promise<void>,
  attempts: number,
  intervalMs: number,
): Promise<BoundedWaitOutcome<T>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await check();
    if (result.kind === "done") return { status: "done", value: result.value };
    if (result.kind === "failed") return { status: "failed", message: result.message };
    if (attempt < attempts - 1) await wait(intervalMs);
  }
  return { status: "timed-out" };
}

/**
 * A GitHub Actions workflow-command line, `message` run through the workflow-command data
 * encoding (`%` first, so encoding `\r`/`\n` never gets re-escaped) — the boundary every
 * `::error ::`/`::warning ::` this script emits goes through.
 */
function workflowCommand(kind: "error" | "warning", message: string): string {
  const encoded = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${kind} ::${encoded}`;
}

/** Leading numeric component, `v` stripped. Only postgres carries more than one line. */
function releaseLine(version: string): string {
  const withoutPrefix = version.replace(/^[vV]/, "");
  const separator = withoutPrefix.indexOf(".");
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

/**
 * Matches a `<service>-<upstream>-r<N>` release tag. With `upstream` given, matches only that
 * exact upstream (what `resolveRevisionPin` needs); with it omitted, captures any upstream as
 * group 1 and the revision as group 2 (what the planner needs to enumerate every committed
 * revision of every upstream a service carries). A tag with no `-r<N>` suffix — legacy — never
 * matches either shape.
 */
function releaseTagPattern(service: string, upstream?: string): RegExp {
  const upstreamPart = upstream === undefined ? "(.+)" : escapeRegExp(upstream);
  return new RegExp(`^${escapeRegExp(service)}-${upstreamPart}-r(0|[1-9][0-9]*)$`);
}

/**
 * Strips a leading `v`/`V` and one trailing `-sha-<hex>`, then parses the remainder as dot-
 * separated integers. Returns undefined when the remainder isn't `^\d+(\.\d+)*$` — a version that
 * isn't comparable this way, such as an OrioleDB-style suffix.
 */
function comparableVersion(version: string): ReadonlyArray<number> | undefined {
  const stripped = version.replace(/^[vV]/, "").replace(/-sha-[0-9a-f]+$/i, "");
  if (!/^\d+(\.\d+)*$/.test(stripped)) return undefined;
  return stripped.split(".").map(Number);
}

/**
 * Numeric ordering of two upstream versions: `-1` when `a` is older, `0` when neither is newer
 * (including two versions that only differ in a stripped `-sha-<hex>` suffix, e.g. two Studio
 * builds on the same date), `1` when `a` is newer. Undefined when either isn't comparable.
 */
function compareVersions(a: string, b: string): number | undefined {
  const av = comparableVersion(a);
  const bv = comparableVersion(b);
  if (av === undefined || bv === undefined) return undefined;
  const length = Math.max(av.length, bv.length);
  for (let index = 0; index < length; index++) {
    const left = av[index] ?? 0;
    const right = bv[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export interface CatalogPinUpdate {
  readonly service: string;
  readonly version: string;
  readonly revision: number;
  readonly previousVersion: string;
  readonly target: "default" | "additional";
}

/** Content pin for one resolved `<upstream>-r<N>` revision, ready to serialize into the catalog. */
interface ResolvedPin {
  readonly upstreamVersion: string;
  readonly revision: number;
  readonly image: string;
  /**
   * The pin's `ArtifactPin.upstreamImage`. Populated by manual mode (`refreshCatalogPin`) via
   * `resolveUpstreamImage` below, when `io` carries `fetchManifest`/`fetchProvenance`.
   */
  readonly upstreamImage?: string;
  readonly natives: Readonly<
    Record<NativeTargetName, { readonly archive: string; readonly manifest: string }>
  >;
}

export type RevisionResolution =
  | { readonly status: "resolved"; readonly pin: ResolvedPin }
  | {
      readonly status: "missing" | "incomplete" | "stale" | "lookup-failed";
      readonly message: string;
    };

/**
 * Network ports the resolver needs: the release list (for revision allocation), a release's
 * `SHA256SUMS` body, the GHCR manifest digest, and a byte source's sha256. Tests stub these
 * directly.
 */
export interface RevisionIo {
  /** Tags of every published, non-draft release — a draft is not yet a committed revision. */
  readonly listReleaseTags: () => Promise<ReadonlyArray<string>>;
  readonly fetchChecksums: (service: string, releaseVersion: string) => Promise<string | undefined>;
  readonly imageDigest: (service: string, releaseVersion: string) => Promise<string | undefined>;
  readonly s3Sha256: (url: string) => Promise<string | undefined>;
  /** Overridable real delay between the S3-mirror wait's bounded attempts. */
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * Raw contents of a native target's `.manifest.json` release asset, for a derived service's
   * `upstream_image` (or `source_image` on an image-derived build, e.g. postgrest's Linux
   * targets). Optional: only manual mode's `upstreamImage` backfill (`resolveUpstreamImage`)
   * calls this, so a test `io` that doesn't exercise that path can omit it.
   */
  readonly fetchManifest?: (
    service: string,
    releaseVersion: string,
    target: NativeTargetName,
  ) => Promise<string | undefined>;
  /**
   * Raw contents of a mirrored service's `<service>-<upstreamVersion>.oci-provenance.json`
   * release asset, whose `source` field is the mirrored upstream image. Optional for the same
   * reason as `fetchManifest`.
   */
  readonly fetchProvenance?: (
    service: string,
    releaseVersion: string,
    upstreamVersion: string,
  ) => Promise<string | undefined>;
}

function desiredImage(service: string, releaseVersion: string, digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new InvalidPayloadError(`missing slim digest for ${service}:${releaseVersion}`);
  }
  return `${SLIM_IMAGE_PREFIX}${service}:${releaseVersion}@${digest}`;
}

/**
 * Resolves `service`'s committed `<upstream>-r<N>` revision, pinned by content: the GHCR
 * manifest digest, and every native target's archive and manifest sha256, cross-checked against
 * the S3 mirror copy.
 *
 * With `requiredRevision` given, that exact revision must already be committed — this is what
 * pins exactly a planned release (`--release`), never "highest at apply time". Without it, the
 * highest committed revision of `upstream` is used (`--upstream`, and the hotfix/upgrade default).
 */
export async function resolveRevisionPin(
  service: string,
  upstream: string,
  io: RevisionIo,
  requiredRevision?: number,
): Promise<RevisionResolution> {
  const tagPattern = releaseTagPattern(service, upstream);
  const seenRevisions = new Set<number>();
  let highest: number | undefined;
  for (const tag of await io.listReleaseTags()) {
    const match = tagPattern.exec(tag);
    if (match === null) continue;
    const revision = Number(match[1]);
    seenRevisions.add(revision);
    if (highest === undefined || revision > highest) highest = revision;
  }

  let target: number;
  if (requiredRevision !== undefined) {
    if (!seenRevisions.has(requiredRevision)) {
      return {
        status: "missing",
        message: `${service}:${upstream}-r${requiredRevision} is not a committed slim-services release.`,
      };
    }
    target = requiredRevision;
  } else {
    if (highest === undefined) {
      return {
        status: "missing",
        message: `${service}:${upstream} has no published slim-services revision.`,
      };
    }
    target = highest;
  }

  const releaseVersion = `${upstream}-r${target}`;
  const checksums = await io.fetchChecksums(service, releaseVersion);
  if (checksums === undefined) {
    return {
      status: "incomplete",
      message: `${service}-${releaseVersion} has no SHA256SUMS asset.`,
    };
  }

  const natives: Record<string, { archive: string; manifest: string }> = {};
  for (const target of NATIVE_TARGETS) {
    const files = nativeFileNames(service, releaseVersion, target);
    const archive = checksumFor(checksums, files.archive);
    const manifest = checksumFor(checksums, files.manifest);
    if (archive === undefined || manifest === undefined) {
      return {
        status: "incomplete",
        message: `${service}-${releaseVersion} SHA256SUMS has no line for ${
          archive === undefined ? files.archive : files.manifest
        }.`,
      };
    }
    natives[target] = { archive, manifest };
  }

  const digest = await io.imageDigest(service, releaseVersion);
  if (digest === undefined || !DIGEST_PATTERN.test(digest)) {
    return {
      status: "lookup-failed",
      message: `${SLIM_IMAGE_PREFIX}${service}:${releaseVersion} has no published manifest.`,
    };
  }

  // `mirror-slim-image.yml`'s S3 upload runs in parallel, best-effort, so a freshly committed
  // revision's S3 copy can briefly lag GitHub: a missing object waits, bounded; a present object
  // with the wrong bytes fails immediately instead of waiting.
  for (const target of NATIVE_TARGETS) {
    const files = nativeFileNames(service, releaseVersion, target);
    for (const part of ["archive", "manifest"] as const) {
      const url = nativeObjectUrl(service, releaseVersion, files[part]);
      const expected = natives[target]?.[part] as string;
      const outcome = await boundedWait<true>(
        async () => {
          const actual = await io.s3Sha256(url);
          if (actual === undefined) {
            console.log(
              `Waiting for the S3 mirror of ${service}-${releaseVersion} ${target} (${part})...`,
            );
            return { kind: "retry" };
          }
          if (actual !== expected) {
            return {
              kind: "failed",
              message: `S3 copy of ${releaseVersion} ${target} (${part}) is stale (digest mismatch); run the slim-services mirror backfill.`,
            };
          }
          return { kind: "done", value: true };
        },
        io.wait ?? sleep,
        S3_WAIT_ATTEMPTS,
        s3WaitIntervalMs(),
      );
      if (outcome.status === "failed") {
        return { status: "stale", message: outcome.message };
      }
      if (outcome.status === "timed-out") {
        return {
          status: "stale",
          message: `S3 copy of ${releaseVersion} ${target} (${part}) never appeared; the S3 mirror hasn't finished — check mirror-slim-image.yml for this release, backfill if needed, and re-run.`,
        };
      }
    }
  }

  return {
    status: "resolved",
    pin: {
      upstreamVersion: upstream,
      revision: target,
      image: desiredImage(service, releaseVersion, digest),
      natives: natives as Record<NativeTargetName, { archive: string; manifest: string }>,
    },
  };
}

/**
 * Services slim-services mirrors from an unmodified upstream image rather than building from
 * source: their `upstreamImage` comes from the release's `oci-provenance.json` `source` field,
 * not a native target's manifest. Keep this in sync with `SlimServicesSource`'s mirror-mode
 * services.
 */
const MIRROR_MODE_SOURCE_SERVICES: ReadonlySet<string> = new Set(["vector", "mailpit", "imgproxy"]);

function parseJsonRecord(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Strips a `docker.io/` prefix and any `@sha256:…` digest, to match the Dockerfile's `FROM` form. */
function normalizeUpstreamImage(image: string): string {
  const withoutDigest = image.split("@")[0] ?? image;
  return withoutDigest.startsWith("docker.io/")
    ? withoutDigest.slice("docker.io/".length)
    : withoutDigest;
}

/**
 * A normalized `upstreamImage`: one or more lowercase `registry`/`repository` path segments
 * (each `[a-z0-9]`, optionally separated internally by `.`/`_`/`-`), a `:`, and a tag matching
 * Docker's own tag grammar. Anchored, so no whitespace, quote, or template/expression syntax can
 * slip through — this value gets embedded as a TypeScript string literal in `Artifacts.ts`.
 */
const IMAGE_REFERENCE_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Validates a normalized `upstreamImage` before it's ever written to `Artifacts.ts`. */
function validateUpstreamImage(image: string, context: string): string {
  if (!IMAGE_REFERENCE_PATTERN.test(image)) {
    throw new InvalidPayloadError(
      `${context} has an invalid upstreamImage ${JSON.stringify(image)}.`,
    );
  }
  return image;
}

/**
 * Resolves `service`'s `upstreamImage` for the release `releaseVersion` (`<upstream>-r<N>`):
 * a mirrored service's `oci-provenance.json` `source`, or a derived service's per-target
 * manifest `upstream_image` (falling back to `source_image` for an image-derived build, e.g.
 * postgrest's Linux targets) — cross-checked across every native target, so a derived service
 * whose manifests disagree fails instead of silently picking one. Only manual mode
 * (`refreshCatalogPin`) calls this; `io` must carry `fetchManifest`/`fetchProvenance`.
 */
async function resolveUpstreamImage(
  service: string,
  releaseVersion: string,
  upstreamVersion: string,
  io: RevisionIo,
): Promise<string> {
  if (MIRROR_MODE_SOURCE_SERVICES.has(service)) {
    if (io.fetchProvenance === undefined) {
      throw new InvalidPayloadError(
        `${service} needs an io.fetchProvenance to resolve upstreamImage.`,
      );
    }
    const provenance = await io.fetchProvenance(service, releaseVersion, upstreamVersion);
    if (provenance === undefined) {
      throw new InvalidPayloadError(`${service}-${releaseVersion} has no oci-provenance asset.`);
    }
    const source = stringField(parseJsonRecord(provenance), "source");
    if (source === undefined) {
      throw new InvalidPayloadError(
        `${service}-${releaseVersion} oci-provenance has no 'source' field.`,
      );
    }
    return validateUpstreamImage(normalizeUpstreamImage(source), `${service}-${releaseVersion}`);
  }

  if (io.fetchManifest === undefined) {
    throw new InvalidPayloadError(`${service} needs an io.fetchManifest to resolve upstreamImage.`);
  }
  const values = new Set<string>();
  for (const target of NATIVE_TARGETS) {
    const manifest = await io.fetchManifest(service, releaseVersion, target);
    if (manifest === undefined) {
      throw new InvalidPayloadError(
        `${service}-${releaseVersion}-${target} has no manifest asset.`,
      );
    }
    const record = parseJsonRecord(manifest);
    const value = stringField(record, "upstream_image") ?? stringField(record, "source_image");
    if (value === undefined) {
      throw new InvalidPayloadError(
        `${service}-${releaseVersion}-${target} manifest has neither 'upstream_image' nor 'source_image'.`,
      );
    }
    values.add(normalizeUpstreamImage(value));
  }
  if (values.size !== 1) {
    throw new InvalidPayloadError(
      `${service}-${releaseVersion} manifests disagree on the upstream image: ${[...values]
        .sort()
        .map((value) => JSON.stringify(value))
        .join(", ")}.`,
    );
  }
  return validateUpstreamImage([...values][0] as string, `${service}-${releaseVersion}`);
}

/**
 * Serializes a resolved pin into the object literal `Artifacts.ts` embeds, in catalog order.
 * Every string field goes through `JSON.stringify`, not manual `"${…}"` interpolation — this
 * text is written straight into TypeScript source that later gets imported, so an unescaped
 * quote or template expression in any field (release metadata included) would inject code.
 */
function serializePin(pin: ResolvedPin): string {
  const natives = NATIVE_TARGETS.map((target) => {
    const native = pin.natives[target];
    return `${JSON.stringify(target)}: { archive: ${JSON.stringify(native.archive)}, manifest: ${JSON.stringify(native.manifest)} }`;
  }).join(", ");
  const upstreamImage =
    pin.upstreamImage === undefined ? "" : ` upstreamImage: ${JSON.stringify(pin.upstreamImage)},`;
  return `{ upstreamVersion: ${JSON.stringify(pin.upstreamVersion)}, revision: ${pin.revision}, image: ${JSON.stringify(pin.image)},${upstreamImage} natives: { ${natives} } }`;
}

interface PinSpan {
  readonly start: number;
  readonly end: number;
  readonly version: string;
  /**
   * Span of an additional (release-line-keyed) pin's own string key, content only (no quotes).
   * Absent for the default pin, which carries no separate key to keep in sync.
   */
  readonly key?: { readonly start: number; readonly end: number };
}

/**
 * Index right after the matching close-bracket for the open-bracket character at `openIndex`
 * (which must itself be `open`). Skips string contents, so a formatter's line-wrapping, trailing
 * commas, or reordered properties never confuse the boundary — only bracket balance matters.
 */
function scanBalanced(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let index = openIndex;
  for (; index < source.length; index++) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index++;
        index++;
      }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  throw new InvalidPayloadError(`unterminated '${open}' while parsing ${CATALOG_PATH}`);
}

/** Loosely finds `upstreamVersion` anywhere inside a resolved pin literal's text. */
const PIN_UPSTREAM_VERSION = /upstreamVersion:\s*"([^"]+)"/;
/** Loosely finds `revision` anywhere inside a resolved pin literal's text. */
const PIN_REVISION = /revision:\s*(\d+)/;

/**
 * Matches a resolved `ArtifactPin` object literal starting exactly at `index`. The span is found
 * by bracket balance, then the version is pulled out with a loose field search — so a formatter's
 * whitespace, line breaks, trailing commas, or property order never break matching, only the
 * literal shape itself would.
 */
function matchPinAt(source: string, index: number): PinSpan | undefined {
  if (source[index] === "{") {
    const end = scanBalanced(source, index, "{", "}");
    const version = PIN_UPSTREAM_VERSION.exec(source.slice(index, end))?.[1];
    return version === undefined ? undefined : { start: index, end, version };
  }
  return undefined;
}

interface ServicePins {
  readonly defaultPin: PinSpan;
  readonly additional: ReadonlyArray<PinSpan>;
}

/**
 * Finds every pin expression `service` carries in `source`: the `definition("<service>", <pin>,
 * ...)` default pin, plus any additional (release-line-keyed) pins in its trailing object
 * argument. Both `selectEntry` and `planSlimUpdates` build on this single traversal.
 */
function collectServicePins(source: string, service: string): ServicePins | undefined {
  const prefix = new RegExp(`definition\\(\\s*"${escapeRegExp(service)}"\\s*,\\s*`);
  const prefixMatch = prefix.exec(source);
  if (prefixMatch === null) return undefined;
  const pinIndex = prefixMatch.index + prefixMatch[0].length;
  const defaultPin = matchPinAt(source, pinIndex);
  if (defaultPin === undefined) return undefined;

  const openParenIndex = prefixMatch.index + prefixMatch[0].indexOf("(");
  const callEnd = scanBalanced(source, openParenIndex, "(", ")");

  const additional: PinSpan[] = [];
  const keyPattern = /"([^"]+)"\s*:\s*/g;
  keyPattern.lastIndex = defaultPin.end;
  for (
    let keyMatch = keyPattern.exec(source);
    keyMatch !== null;
    keyMatch = keyPattern.exec(source)
  ) {
    if (keyMatch.index >= callEnd) break;
    const valueStart = keyMatch.index + keyMatch[0].length;
    const pin = matchPinAt(source, valueStart);
    if (pin === undefined) {
      keyPattern.lastIndex = valueStart;
      continue;
    }
    const keyText = keyMatch[1] ?? "";
    const keyStart = keyMatch.index + keyMatch[0].indexOf(keyText);
    additional.push({ ...pin, key: { start: keyStart, end: keyStart + keyText.length } });
    keyPattern.lastIndex = pin.end;
  }

  return { defaultPin, additional };
}

type SelectedEntry =
  | { readonly kind: "default" | "additional"; readonly version: string; readonly span: PinSpan }
  | { readonly kind: "unmodelled-service" }
  | { readonly kind: "unmodelled-release-line"; readonly known: ReadonlyArray<string> };

/**
 * Locates `service`'s pin expression in `source`: the `definition("<service>", <pin>, ...)`
 * default pin, and, when `version` is given, whichever pin (default or additional) sits on its
 * release line. With no `version`, returns the default pin unconditionally.
 */
function selectEntry(source: string, service: string, version: string | undefined): SelectedEntry {
  const pins = collectServicePins(source, service);
  if (pins === undefined) return { kind: "unmodelled-service" };
  const { defaultPin, additional } = pins;

  if (version === undefined) {
    return { kind: "default", version: defaultPin.version, span: defaultPin };
  }

  const bumpsDefault =
    additional.length === 0 || releaseLine(version) === releaseLine(defaultPin.version);
  if (bumpsDefault) {
    return { kind: "default", version: defaultPin.version, span: defaultPin };
  }
  const sameLine = additional.find((pin) => releaseLine(pin.version) === releaseLine(version));
  if (sameLine === undefined) {
    return {
      kind: "unmodelled-release-line",
      known: [defaultPin.version, ...additional.map((pin) => pin.version)],
    };
  }
  return { kind: "additional", version: sameLine.version, span: sameLine };
}

/** The `{service, upstream_version, revision, release_version}` payload a `slim-release-published` dispatch carries. */
export interface SlimReleasePublishedPayload {
  readonly service: string;
  readonly upstream_version: string;
  readonly revision: number;
  readonly release_version: string;
}

/** Every upstream tag format the catalog carries, including Studio's `2026.09.04-sha-5a67366`. */
const UPSTREAM_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9-]+$/;
const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-r(0|[1-9][0-9]*)$/;

/**
 * Validates an untrusted `slim-release-published` dispatch payload before any of its fields are
 * written anywhere (a `$GITHUB_OUTPUT` line, a branch name, a PR title, …). Every field is checked
 * against an anchored charset — `upstream_version` and `release_version` included, not just
 * `service` and `revision` — so a value carrying a newline or shell/Actions metacharacter is
 * rejected here instead of being echoed downstream.
 */
export function validateSlimReleasePublishedPayload(input: {
  readonly service: string;
  readonly upstream_version: string;
  readonly revision: string;
  readonly release_version: string;
}): SlimReleasePublishedPayload {
  if (!SERVICE_NAME_PATTERN.test(input.service)) {
    throw new InvalidPayloadError(`invalid service: ${JSON.stringify(input.service)}`);
  }
  if (!UPSTREAM_VERSION_PATTERN.test(input.upstream_version)) {
    throw new InvalidPayloadError(
      `invalid upstream_version: ${JSON.stringify(input.upstream_version)}`,
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(input.revision)) {
    throw new InvalidPayloadError(`invalid revision: ${JSON.stringify(input.revision)}`);
  }
  if (!RELEASE_VERSION_PATTERN.test(input.release_version)) {
    throw new InvalidPayloadError(
      `invalid release_version: ${JSON.stringify(input.release_version)}`,
    );
  }
  const revision = Number(input.revision);
  const expected = `${input.upstream_version}-r${revision}`;
  if (input.release_version !== expected) {
    throw new InvalidPayloadError(
      `release_version ${JSON.stringify(input.release_version)} does not match derived ${JSON.stringify(expected)}`,
    );
  }
  return {
    service: input.service,
    upstream_version: input.upstream_version,
    revision,
    release_version: input.release_version,
  };
}

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Writes `pin` over `entry`'s span in `source`, or leaves it unchanged when it already matches.
 * An additional (release-line-keyed) pin also gets its own string key rewritten to `pin`'s
 * `upstreamVersion` when it moves to a different upstream version, so the key an additional pin
 * is looked up by never drifts from the `upstreamVersion` its resolved pin literal carries.
 */
function writePin(
  source: string,
  entry: Extract<SelectedEntry, { kind: "default" | "additional" }>,
  pin: ResolvedPin,
): { readonly source: string; readonly changed: boolean } {
  const desired = serializePin(pin);
  const current = source.slice(entry.span.start, entry.span.end);
  let next = source;
  let changed = false;
  if (normalizeText(current) !== normalizeText(desired)) {
    next = next.slice(0, entry.span.start) + desired + next.slice(entry.span.end);
    changed = true;
  }
  const key = entry.span.key;
  if (key !== undefined && source.slice(key.start, key.end) !== pin.upstreamVersion) {
    next = next.slice(0, key.start) + pin.upstreamVersion + next.slice(key.end);
    changed = true;
  }
  return { source: next, changed };
}

/**
 * One hotfix or upgrade a `slim-release-published` run should apply, on one of `service`'s
 * release lines. `line` is the leading numeric component (`releaseLine`), present only when the
 * service carries more than one line (only postgres does today) — it's already folded into
 * `branch`, so a caller never needs to consume it separately.
 */
export interface SlimUpdate {
  readonly kind: "hotfix" | "upgrade";
  readonly line?: string;
  readonly branch: string;
  readonly title: string;
  /** The release version pinned before this update, e.g. `v2.195.0-r0`. */
  readonly fromRelease: string;
  readonly toUpstream: string;
  /** The release version this update pins, e.g. `v2.195.0-r1`. */
  readonly toRelease: string;
}

/**
 * Builds one `SlimUpdate`, validating every value it emits — `service`, `toUpstream` and
 * `toRelease` — against the same anchored patterns `validateSlimReleasePublishedPayload` uses,
 * before any of them reaches a branch name or PR title. Release tag names (the ultimate source of
 * `toUpstream`) come from an external API, so this check applies even to values derived from the
 * catalog itself (`fromRelease`'s upstream), not only to values freshly parsed from a tag.
 */
function buildUpdate(
  kind: "hotfix" | "upgrade",
  service: string,
  line: string,
  hasLines: boolean,
  pinned: { readonly upstream: string; readonly revision: number },
  toUpstream: string,
  toRevision: number,
): SlimUpdate {
  if (!SERVICE_NAME_PATTERN.test(service)) {
    throw new InvalidPayloadError(`invalid service: ${JSON.stringify(service)}`);
  }
  if (!UPSTREAM_VERSION_PATTERN.test(toUpstream)) {
    throw new InvalidPayloadError(`invalid upstream version: ${JSON.stringify(toUpstream)}`);
  }
  const toRelease = `${toUpstream}-r${toRevision}`;
  if (!RELEASE_VERSION_PATTERN.test(toRelease)) {
    throw new InvalidPayloadError(`invalid release version: ${JSON.stringify(toRelease)}`);
  }
  const fromRelease = `${pinned.upstream}-r${pinned.revision}`;
  const suffix = hasLines ? `-${line}` : "";
  const branch =
    kind === "hotfix" ? `slim-hotfix/${service}${suffix}` : `slim-bump/${service}${suffix}`;
  const title =
    kind === "hotfix"
      ? `chore(stack): pin ${service} ${toRelease}`
      : `chore(stack): bump ${service} to ${toRelease}`;

  return {
    kind,
    line: hasLines ? line : undefined,
    branch,
    title,
    fromRelease,
    toUpstream,
    toRelease,
  };
}

export interface PlanSlimUpdatesResult {
  readonly updates: ReadonlyArray<SlimUpdate>;
  /** `::warning ::…` workflow-command lines, for the caller to print to stdout. */
  readonly warnings: ReadonlyArray<string>;
}

/** Groups every candidate release tag under one bucket, for a service with no additional pins. */
const SINGLE_LINE_KEY = "*";

/**
 * The hotfix and/or upgrade a `slim-release-published` run should apply for `service`, computed
 * against `catalog`'s current pins and `releaseTags` (every committed — published, non-draft —
 * slim-services release tag; the caller filters drafts before calling this). Pure: no network, no
 * file I/O, no logging — every diagnostic comes back in `warnings` instead, so a caller (the CLI,
 * or a test) decides where it goes. This matters because `plan-updates` writes `updates` straight
 * into a file the workflow parses as records; a `console.log`'d warning on the same stdout the
 * workflow captures would corrupt that file instead of just being informational.
 *
 * Per release line (the default pin's line, plus one per additional pin — only postgres
 * has more than one) a **hotfix** fires when the pinned upstream has a committed revision higher
 * than the pinned one; an **upgrade** fires when the newest committed upstream on the line is
 * newer than the pinned one (ties, e.g. two Studio builds dated the same day, are not newer).
 * Both can fire in the same run. A service with no additional pins has exactly one line and
 * accepts any comparable upstream on it — a Studio year rollover or a postgrest major bump is
 * the same line moving forward, not a different one, so it is never filtered by `releaseLine`.
 * Only a service that does carry additional pins (postgres) filters a release tag to the line its
 * `releaseLine` names; a tag on no such line, or whose version isn't comparable, is warned about
 * and ignored — it never causes a plan-updates run to fail.
 */
export function planSlimUpdates(
  catalog: string,
  service: string,
  releaseTags: ReadonlyArray<string>,
): PlanSlimUpdatesResult {
  const warnings: string[] = [];
  const pins = collectServicePins(catalog, service);
  if (pins === undefined) {
    warnings.push(
      workflowCommand(
        "warning",
        `${CATALOG_PATH} has no slim entry for ${service}; nothing to plan.`,
      ),
    );
    return { updates: [], warnings };
  }

  const allPins = [pins.defaultPin, ...pins.additional];
  const hasLines = pins.additional.length > 0;

  const pinnedByLine = new Map<string, { readonly upstream: string; readonly revision: number }>();
  for (const span of allPins) {
    const line = hasLines ? releaseLine(span.version) : SINGLE_LINE_KEY;
    const text = catalog.slice(span.start, span.end);
    const revisionMatch = PIN_REVISION.exec(text);
    if (revisionMatch === null) {
      throw new InvalidPayloadError(
        `${CATALOG_PATH} has no revision for ${service} ${span.version}; a committed catalog always pins a resolved revision.`,
      );
    }
    pinnedByLine.set(line, { upstream: span.version, revision: Number(revisionMatch[1]) });
  }

  const tagPattern = releaseTagPattern(service);
  const candidatesByLine = new Map<string, Array<{ upstream: string; revision: number }>>();
  for (const tag of releaseTags) {
    const match = tagPattern.exec(tag);
    if (match === null) continue; // not this service, or a legacy tag with no `-rN`: ignored.
    const upstream = match[1] as string;
    const revision = Number(match[2]);
    let line: string;
    if (hasLines) {
      line = releaseLine(upstream);
      if (!pinnedByLine.has(line)) {
        warnings.push(
          workflowCommand(
            "warning",
            `${service} ${upstream} is not on a release line ${CATALOG_PATH} carries for it; ignoring ${tag}.`,
          ),
        );
        continue;
      }
    } else {
      line = SINGLE_LINE_KEY;
    }
    const list = candidatesByLine.get(line) ?? [];
    list.push({ upstream, revision });
    candidatesByLine.set(line, list);
  }

  const updates: SlimUpdate[] = [];
  for (const [line, pinned] of pinnedByLine) {
    const candidates = candidatesByLine.get(line) ?? [];

    const sameUpstreamRevisions = candidates
      .filter((candidate) => candidate.upstream === pinned.upstream)
      .map((candidate) => candidate.revision);
    if (sameUpstreamRevisions.length > 0) {
      const highest = Math.max(...sameUpstreamRevisions);
      if (highest > pinned.revision) {
        updates.push(
          buildUpdate("hotfix", service, line, hasLines, pinned, pinned.upstream, highest),
        );
      }
    }

    const highestRevisionByUpstream = new Map<string, number>();
    for (const candidate of candidates) {
      const current = highestRevisionByUpstream.get(candidate.upstream);
      if (current === undefined || candidate.revision > current) {
        highestRevisionByUpstream.set(candidate.upstream, candidate.revision);
      }
    }

    let bestUpstream: string | undefined;
    for (const upstream of highestRevisionByUpstream.keys()) {
      const comparedToPinned = compareVersions(upstream, pinned.upstream);
      if (comparedToPinned === undefined) {
        warnings.push(
          workflowCommand(
            "warning",
            `${service} ${upstream} is not a comparable version; ignoring.`,
          ),
        );
        continue;
      }
      if (bestUpstream === undefined || (compareVersions(upstream, bestUpstream) ?? 0) > 0) {
        bestUpstream = upstream;
      }
    }
    if (bestUpstream !== undefined && compareVersions(bestUpstream, pinned.upstream) === 1) {
      const revision = highestRevisionByUpstream.get(bestUpstream) as number;
      updates.push(buildUpdate("upgrade", service, line, hasLines, pinned, bestUpstream, revision));
    }
  }

  return { updates, warnings };
}

/**
 * Reads every committed release tag through `listReleaseTags` and plans against `catalog`. The
 * injectable lister is the seam a dry run or an end-to-end test uses to exercise the whole
 * `plan-updates` transport — this function plus the CLI's file/stdout wiring — without a network
 * call, the same pattern `RevisionIo.listReleaseTags` already uses.
 */
export async function planUpdatesForService(input: {
  readonly catalog: string;
  readonly service: string;
  readonly listReleaseTags: () => Promise<ReadonlyArray<string>>;
}): Promise<PlanSlimUpdatesResult> {
  const releaseTags = await input.listReleaseTags();
  return planSlimUpdates(input.catalog, input.service, releaseTags);
}

export interface WaitForExpectedReleaseResult {
  readonly visible: boolean;
  /** The last listing `listReleaseTags` returned, whichever attempt it came from. */
  readonly tags: ReadonlyArray<string>;
}

/**
 * Eventual-consistency handling of the releases API lagging behind the `slim-release-published`
 * dispatch that triggered this run: re-lists up to `attempts` times, `io.wait`-ing between
 * attempts, until `<service>-<releaseVersion>` appears. Not a test retry — a real, bounded wait
 * for an external API to catch up. `io.wait` is the seam a unit test overrides to skip the real
 * delay; an integration test instead shrinks the real delay via `SLIM_UPDATES_EXPECT_RELEASE_WAIT_MS`
 * (parsed fresh by `expectReleaseIntervalMs` on every call this default reaches), since a
 * subprocess can't be handed a function.
 */
export async function waitForExpectedRelease(
  service: string,
  releaseVersion: string,
  io: {
    readonly listReleaseTags: () => Promise<ReadonlyArray<string>>;
    readonly wait: (ms: number) => Promise<void>;
  },
  attempts: number = EXPECT_RELEASE_ATTEMPTS,
  intervalMs: number = expectReleaseIntervalMs(),
): Promise<WaitForExpectedReleaseResult> {
  const expectedTag = `${service}-${releaseVersion}`;
  let tags: ReadonlyArray<string> = [];
  const outcome = await boundedWait<true>(
    async () => {
      tags = await io.listReleaseTags();
      return tags.includes(expectedTag) ? { kind: "done", value: true } : { kind: "retry" };
    },
    io.wait,
    attempts,
    intervalMs,
  );
  return { visible: outcome.status === "done", tags };
}

export interface CatalogRefreshResult {
  readonly source: string;
  readonly update?: CatalogPinUpdate;
}

/**
 * Refreshes one catalog entry: to exactly the committed release named by `release` (`<U>-r<N>`,
 * required to already be committed — never "highest at apply time"), or to the highest committed
 * revision of `upstream` (or, when both are omitted, of the entry's currently pinned upstream
 * version). `upstream` and `release` are mutually exclusive. Pure aside from `io`: callers own
 * reading and writing `Artifacts.ts`.
 */
export async function refreshCatalogPin(input: {
  readonly catalog: string;
  readonly service: string;
  readonly upstream?: string;
  readonly release?: string;
  readonly io: RevisionIo;
}): Promise<CatalogRefreshResult> {
  if (input.upstream !== undefined && input.release !== undefined) {
    throw new InvalidPayloadError("--upstream and --release are mutually exclusive.");
  }
  if (input.upstream !== undefined && !UPSTREAM_VERSION_PATTERN.test(input.upstream)) {
    throw new InvalidPayloadError(`invalid --upstream '${input.upstream}'`);
  }

  let upstream = input.upstream;
  let requiredRevision: number | undefined;
  if (input.release !== undefined) {
    if (!RELEASE_VERSION_PATTERN.test(input.release)) {
      throw new InvalidPayloadError(`invalid --release '${input.release}'`);
    }
    const match = /^(.+)-r(0|[1-9][0-9]*)$/.exec(input.release) as RegExpExecArray;
    upstream = match[1];
    requiredRevision = Number(match[2]);
  }

  const entry = selectEntry(input.catalog, input.service, upstream);
  if (entry.kind === "unmodelled-service") {
    throw new InvalidPayloadError(`${CATALOG_PATH} has no slim entry for ${input.service}.`);
  }
  if (entry.kind === "unmodelled-release-line") {
    throw new InvalidPayloadError(
      `${input.service} ${upstream ?? ""} is not on a release line ${CATALOG_PATH} carries (${entry.known.join(", ")}).`,
    );
  }
  const resolvedUpstream = upstream ?? entry.version;
  const resolution = await resolveRevisionPin(
    input.service,
    resolvedUpstream,
    input.io,
    requiredRevision,
  );
  if (resolution.status !== "resolved") {
    throw new InvalidPayloadError(resolution.message);
  }
  // Manual mode also backfills `upstreamImage`, so a plain `io` (most tests) can still exercise
  // revision resolution without stubbing the extra fetchers.
  const pin =
    input.io.fetchManifest === undefined && input.io.fetchProvenance === undefined
      ? resolution.pin
      : {
          ...resolution.pin,
          upstreamImage: await resolveUpstreamImage(
            input.service,
            `${resolution.pin.upstreamVersion}-r${resolution.pin.revision}`,
            resolvedUpstream,
            input.io,
          ),
        };
  const written = writePin(input.catalog, entry, pin);
  if (!written.changed) return { source: input.catalog };
  return {
    source: written.source,
    update: {
      service: input.service,
      version: resolvedUpstream,
      revision: resolution.pin.revision,
      previousVersion: entry.version,
      target: entry.kind,
    },
  };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "supabase-cli-catalog-sync",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token !== "") headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Tags of every published, non-draft `supabase/slim-services` release. A draft is never a committed revision. */
async function listReleaseTags(): Promise<ReadonlyArray<string>> {
  const tags: string[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${RELEASES_API}?per_page=100&page=${page}`, {
      headers: githubHeaders(),
    });
    if (!response.ok) {
      throw new InvalidPayloadError(
        `slim-services releases list failed (HTTP ${response.status}).`,
      );
    }
    const batch: unknown = await response.json();
    if (!Array.isArray(batch)) {
      throw new InvalidPayloadError("Malformed slim-services releases response.");
    }
    for (const item of batch) {
      const record = item as { tag_name?: unknown; draft?: unknown } | null;
      if (record?.draft === true) continue;
      const tagName = record?.tag_name;
      if (typeof tagName === "string") tags.push(tagName);
    }
    if (batch.length < 100) break;
  }
  return tags;
}

async function fetchChecksums(
  service: string,
  releaseVersion: string,
): Promise<string | undefined> {
  const response = await fetch(`${RELEASE_DOWNLOAD_BASE}/${service}-${releaseVersion}/SHA256SUMS`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new InvalidPayloadError(
      `SHA256SUMS download failed for ${service}-${releaseVersion} (HTTP ${response.status}).`,
    );
  }
  return response.text();
}

async function imageDigest(service: string, releaseVersion: string): Promise<string | undefined> {
  const reference = `${SLIM_IMAGE_PREFIX}${service}:${releaseVersion}`;
  const proc = Bun.spawn(["regctl", "manifest", "head", reference], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const digest = stdout.trim();
  return exit === 0 && DIGEST_PATTERN.test(digest) ? digest : undefined;
}

async function s3Sha256(url: string): Promise<string | undefined> {
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(await response.arrayBuffer()));
  return hasher.digest("hex");
}

async function fetchManifest(
  service: string,
  releaseVersion: string,
  target: NativeTargetName,
): Promise<string | undefined> {
  const files = nativeFileNames(service, releaseVersion, target);
  const response = await fetch(
    `${RELEASE_DOWNLOAD_BASE}/${service}-${releaseVersion}/${files.manifest}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new InvalidPayloadError(
      `manifest download failed for ${service}-${releaseVersion} ${target} (HTTP ${response.status}).`,
    );
  }
  return response.text();
}

async function fetchProvenance(
  service: string,
  releaseVersion: string,
  upstreamVersion: string,
): Promise<string | undefined> {
  const response = await fetch(
    `${RELEASE_DOWNLOAD_BASE}/${service}-${releaseVersion}/${service}-${upstreamVersion}.oci-provenance.json`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new InvalidPayloadError(
      `oci-provenance download failed for ${service}-${releaseVersion} (HTTP ${response.status}).`,
    );
  }
  return response.text();
}

function defaultRevisionIo(): RevisionIo {
  return { listReleaseTags, fetchChecksums, imageDigest, s3Sha256, fetchManifest, fetchProvenance };
}

function parseFlags(argv: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new InvalidPayloadError(`unexpected argument '${arg ?? ""}'`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new InvalidPayloadError(`missing value for --${key}`);
    }
    flags.set(key, value);
    index++;
  }
  return flags;
}

async function runManual(argv: ReadonlyArray<string>): Promise<void> {
  const flags = parseFlags(argv);
  const service = flags.get("service");
  if (service === undefined) {
    throw new InvalidPayloadError(
      "Usage: sync-artifacts-catalog.ts --service <service> [--upstream <U> | --release <U>-r<N>]",
    );
  }
  const catalogPath = CATALOG_PATH;
  const catalog = await Bun.file(catalogPath).text();
  const result = await refreshCatalogPin({
    catalog,
    service,
    upstream: flags.get("upstream"),
    release: flags.get("release"),
    io: defaultRevisionIo(),
  });
  if (result.update === undefined) {
    console.log(`${service} already pins the highest committed revision.`);
    return;
  }
  await Bun.write(catalogPath, result.source);
  console.log(
    `Pinned ${service} ${result.update.target} ${result.update.previousVersion} -> ${result.update.version} r${result.update.revision}.`,
  );
}

/**
 * Line-oriented encoding of one `SlimUpdate`, for a bash loop: `kind`, `branch`, `title` and
 * `release` (the loop's four required fields, driving the checkout/pin/commit/PR steps) plus
 * `from` (the release replaced, for the PR body's "from -> to"). Every field is guaranteed
 * non-empty by construction. `\x1f` (unit separator) is the delimiter, not a tab: a title can
 * carry ordinary whitespace, and `IFS=$'\t' read` would collapse it.
 */
function updateLine(update: SlimUpdate): string {
  return [update.kind, update.branch, update.title, update.toRelease, update.fromRelease].join(
    "\x1f",
  );
}

/**
 * `plan-updates`' records go only into `--output <path>`, never stdout: a caller (the workflow)
 * reads warnings from stdout as `::warning ::…` lines, and would otherwise mistake one for a
 * malformed record and abort a run that had valid updates alongside it.
 *
 * `io.listReleaseTags` defaults to the real network lister but is overridable — the minimal seam
 * a test uses to exercise this CLI mode's own file/stdout wiring (not just the pure planner)
 * without a network call, the same pattern `RevisionIo` already uses. `io.wait` likewise defaults
 * to a real delay but is overridable, the seam `waitForExpectedRelease`'s own unit tests use. The
 * `--service`/`--output` usage check runs before either the catalog read or the lister, so a test
 * can also assert this mode fails fast on a missing flag without touching the network.
 *
 * With `--expect-release <U>-r<N>` given, `<service>-<U>-r<N>` must be among the listed tags
 * before planning runs at all — otherwise this dispatch's own release could be missing from a
 * releases API that hasn't caught up yet, and the run would plan and pass quietly without it
 * (`waitForExpectedRelease` handles the resulting eventual-consistency wait). Still missing after
 * the bounded retries: this mode throws instead of planning, so `main()`'s handler reports an
 * actionable `::error ::` and exits non-zero, and no `--output` file is written.
 */
export async function runPlanUpdates(
  argv: ReadonlyArray<string>,
  io: {
    readonly listReleaseTags: () => Promise<ReadonlyArray<string>>;
    readonly wait?: (ms: number) => Promise<void>;
  } = { listReleaseTags },
): Promise<void> {
  const flags = parseFlags(argv);
  const service = flags.get("service");
  const output = flags.get("output");
  const expectRelease = flags.get("expect-release");
  if (service === undefined || output === undefined) {
    throw new InvalidPayloadError(
      "Usage: sync-artifacts-catalog.ts plan-updates --service <service> --output <path> " +
        "[--format lines] [--expect-release <U>-r<N>]",
    );
  }
  if (!SERVICE_NAME_PATTERN.test(service)) {
    throw new InvalidPayloadError(`invalid --service ${JSON.stringify(service)}`);
  }
  const format = flags.get("format") ?? "json";
  if (format !== "json" && format !== "lines") {
    throw new InvalidPayloadError(`invalid --format '${format}' (expected 'json' or 'lines')`);
  }
  if (expectRelease !== undefined && !RELEASE_VERSION_PATTERN.test(expectRelease)) {
    throw new InvalidPayloadError(`invalid --expect-release ${JSON.stringify(expectRelease)}`);
  }

  let listReleaseTags = io.listReleaseTags;
  if (expectRelease !== undefined) {
    const waited = await waitForExpectedRelease(service, expectRelease, {
      listReleaseTags: io.listReleaseTags,
      wait: io.wait ?? sleep,
    });
    if (!waited.visible) {
      throw new InvalidPayloadError(
        `${service}-${expectRelease} is not visible yet from the slim-services releases API; re-run this workflow once it has propagated.`,
      );
    }
    // Reuses the listing the successful attempt already fetched, instead of listing again.
    listReleaseTags = async () => waited.tags;
  }

  const catalog = await Bun.file(CATALOG_PATH).text();
  const { updates, warnings } = await planUpdatesForService({ catalog, service, listReleaseTags });
  for (const warning of warnings) console.log(warning);
  const content =
    format === "lines"
      ? updates.map((update) => `${updateLine(update)}\n`).join("")
      : `${JSON.stringify(updates)}\n`;
  await Bun.write(output, content);
}

async function runValidatePayload(argv: ReadonlyArray<string>): Promise<void> {
  const flags = parseFlags(argv);
  const service = flags.get("service");
  const upstream = flags.get("upstream");
  const revision = flags.get("revision");
  const release = flags.get("release");
  if (
    service === undefined ||
    upstream === undefined ||
    revision === undefined ||
    release === undefined
  ) {
    throw new InvalidPayloadError(
      "Usage: sync-artifacts-catalog.ts validate-payload --service <service> --upstream <U> --revision <N> --release <R>",
    );
  }
  const payload = validateSlimReleasePublishedPayload({
    service,
    upstream_version: upstream,
    revision,
    release_version: release,
  });
  console.log(`service=${payload.service}`);
  console.log(`upstream_version=${payload.upstream_version}`);
  console.log(`revision=${payload.revision}`);
  console.log(`release_version=${payload.release_version}`);
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === "validate-payload") {
    await runValidatePayload(argv.slice(1));
    return;
  }
  if (argv[0] === "plan-updates") {
    await runPlanUpdates(argv.slice(1));
    return;
  }
  if (argv[0]?.startsWith("--") === true) {
    await runManual(argv);
    return;
  }

  throw new InvalidPayloadError(
    "Usage: sync-artifacts-catalog.ts --service <service> [--upstream <U> | --release <U>-r<N>], " +
      "or validate-payload / plan-updates --service <service>",
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(workflowCommand("error", error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
