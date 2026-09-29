/**
 * Pins `packages/stack/src/Artifacts.ts` to committed `supabase/slim-services`
 * revisions (`<upstream>-r<N>`). Every entry is pinned by content: the GHCR
 * image digest, plus an archive and manifest sha256 per native target.
 *
 * Dependabot mode (used by CI): rewrites every catalog entry whose slim
 * service moved between `dockerfile` and `base-dockerfile`, to the highest
 * committed revision of its new upstream version.
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts <dockerfile> <catalog> [base-dockerfile]
 *
 * Manual mode: refreshes one catalog entry to the highest committed revision
 * of a given upstream version (or of its currently pinned upstream version,
 * when `--upstream` is omitted).
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts --service <service> [--upstream <U>]
 *
 * Hotfix-matches mode (used by the `slim-release-published` dispatch
 * workflow): prints, as JSON, which of a service's catalog pins a hotfix
 * revision should refresh.
 *
 *   bun .github/scripts/sync-artifacts-catalog.ts hotfix-matches --service <service> \
 *     --upstream <U> --revision <N>
 */

import { parseDockerfileServiceImages } from "../../apps/cli/src/shared/services/parse-dockerfile-service-images.ts";
import { isOrioleImage, slimCatalogPin } from "../../apps/cli/src/shared/services/slim-images.ts";
import {
  DIGEST_PATTERN,
  InvalidPayloadError,
  SOURCE_REGISTRY,
  VERSION_PATTERN,
  checksumFor,
  escapeRegExp,
  nativeFileNames,
  nativeObjectUrl,
} from "./slim-mirror-payload.ts";

export const CATALOG_PATH = "packages/stack/src/Artifacts.ts";
const DOCKERFILE_PATH = "apps/cli/src/shared/services/Dockerfile";

const SLIM_IMAGE_PREFIX = `${SOURCE_REGISTRY}/`;

/** The three native targets the catalog pins per revision. Kept self-contained; see module docs. */
const NATIVE_TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;
type NativeTargetName = (typeof NATIVE_TARGETS)[number];

const RELEASES_API = "https://api.github.com/repos/supabase/slim-services/releases";
const RELEASE_DOWNLOAD_BASE = "https://github.com/supabase/slim-services/releases/download";

/** Leading numeric component, `v` stripped. Only postgres carries more than one line. */
function releaseLine(version: string): string {
  const withoutPrefix = version.replace(/^[vV]/, "");
  const separator = withoutPrefix.indexOf(".");
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

/**
 * True when every numeric prefix of `next` is older than `current`. Equal prefixes are not
 * older. Compares upstream versions only; revisions never enter this comparison.
 */
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
  readonly revision: number;
  readonly previousVersion: string;
  readonly target: "default" | "additional";
}

export interface SkippedCatalogPin {
  readonly alias: string;
  readonly reason: string;
  /** OrioleDB and an older Dependabot bump are the non-blocking skips. */
  readonly blocking: boolean;
}

export interface CatalogPlan {
  readonly source: string;
  readonly updates: ReadonlyArray<CatalogPinUpdate>;
  readonly skipped: ReadonlyArray<SkippedCatalogPin>;
}

/** Content pin for one resolved `<upstream>-r<N>` revision, ready to serialize into the catalog. */
interface ResolvedPin {
  readonly upstreamVersion: string;
  readonly revision: number;
  readonly image: string;
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
 * directly, the same way the previous `publication` callback was stubbed.
 */
export interface RevisionIo {
  readonly listReleaseTags: () => Promise<ReadonlyArray<string>>;
  readonly fetchChecksums: (service: string, releaseVersion: string) => Promise<string | undefined>;
  readonly imageDigest: (service: string, releaseVersion: string) => Promise<string | undefined>;
  readonly s3Sha256: (url: string) => Promise<string | undefined>;
}

function desiredImage(service: string, releaseVersion: string, digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new InvalidPayloadError(`missing slim digest for ${service}:${releaseVersion}`);
  }
  return `${SLIM_IMAGE_PREFIX}${service}:${releaseVersion}@${digest}`;
}

/**
 * Resolves `service`'s highest committed `<upstream>-r<N>` revision, pinned by content: the
 * GHCR manifest digest, and every native target's archive and manifest sha256, cross-checked
 * against the S3 mirror copy. See module docs for the five-step protocol.
 */
export async function resolveRevisionPin(
  service: string,
  upstream: string,
  io: RevisionIo,
): Promise<RevisionResolution> {
  const tagPattern = new RegExp(
    `^${escapeRegExp(service)}-${escapeRegExp(upstream)}-r(0|[1-9][0-9]*)$`,
  );
  let highest: number | undefined;
  for (const tag of await io.listReleaseTags()) {
    const match = tagPattern.exec(tag);
    if (match === null) continue;
    const revision = Number(match[1]);
    if (highest === undefined || revision > highest) highest = revision;
  }
  if (highest === undefined) {
    return {
      status: "missing",
      message: `${service}:${upstream} has no published slim-services revision.`,
    };
  }

  const releaseVersion = `${upstream}-r${highest}`;
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

  for (const target of NATIVE_TARGETS) {
    const files = nativeFileNames(service, releaseVersion, target);
    for (const part of ["archive", "manifest"] as const) {
      const url = nativeObjectUrl(service, releaseVersion, files[part]);
      const actual = await io.s3Sha256(url);
      if (actual === undefined || actual !== natives[target]?.[part]) {
        return {
          status: "stale",
          message: `S3 copy of ${releaseVersion} ${target} is stale; run the slim-services mirror backfill`,
        };
      }
    }
  }

  return {
    status: "resolved",
    pin: {
      upstreamVersion: upstream,
      revision: highest,
      image: desiredImage(service, releaseVersion, digest),
      natives: natives as Record<NativeTargetName, { archive: string; manifest: string }>,
    },
  };
}

/** Serializes a resolved pin into the object literal `Artifacts.ts` embeds, in catalog order. */
function serializePin(pin: ResolvedPin): string {
  const natives = NATIVE_TARGETS.map((target) => {
    const native = pin.natives[target];
    return `"${target}": { archive: "${native.archive}", manifest: "${native.manifest}" }`;
  }).join(", ");
  return `{ upstreamVersion: "${pin.upstreamVersion}", revision: ${pin.revision}, image: "${pin.image}", natives: { ${natives} } }`;
}

interface PinSpan {
  readonly start: number;
  readonly end: number;
  readonly version: string;
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

const PLACEHOLDER_PREFIX = /placeholderPin\s*\(/y;
/** Loosely finds `placeholderPin`'s second (version) argument anywhere inside its call text. */
const PLACEHOLDER_VERSION = /"[a-z0-9-]+"\s*,\s*"([^"]+)"/;
/** Loosely finds `upstreamVersion` anywhere inside a resolved pin literal's text. */
const PIN_UPSTREAM_VERSION = /upstreamVersion:\s*"([^"]+)"/;
/** Loosely finds `revision` anywhere inside a resolved pin literal's text. Absent for a `placeholderPin`. */
const PIN_REVISION = /revision:\s*(\d+)/;

/**
 * Matches a pin expression (B1's `placeholderPin(...)` call, or a resolved `ArtifactPin` object
 * literal) starting exactly at `index`. The span is found by bracket balance, then the version is
 * pulled out with a loose field search — so a formatter's whitespace, line breaks, trailing
 * commas, or property order never break matching, only the two literal shapes themselves would.
 */
function matchPinAt(source: string, index: number): PinSpan | undefined {
  PLACEHOLDER_PREFIX.lastIndex = index;
  const placeholderPrefix = PLACEHOLDER_PREFIX.exec(source);
  if (placeholderPrefix !== null) {
    const openParen = index + placeholderPrefix[0].length - 1;
    const end = scanBalanced(source, openParen, "(", ")");
    const version = PLACEHOLDER_VERSION.exec(source.slice(index, end))?.[1];
    return version === undefined ? undefined : { start: index, end, version };
  }
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
 * argument. Both `selectEntry` and `findHotfixMatches` build on this single traversal.
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
    additional.push(pin);
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

export interface HotfixMatch {
  /** Which of `service`'s catalog pins (default, or one of the additional release lines) matched. */
  readonly target: "default" | "additional";
  /** The revision currently pinned; `-1` when the entry is still an unresolved `placeholderPin`. */
  readonly currentRevision: number;
}

/**
 * Every pin `payload.service` carries in `catalog` (default or additional) whose
 * `upstreamVersion` equals `payload.upstream_version` and whose currently pinned revision is
 * lower than `payload.revision` — i.e. the entries a `slim-release-published` hotfix dispatch
 * should refresh. Pure: callers own running the actual refresh and PR flow.
 */
export function findHotfixMatches(
  catalog: string,
  payload: SlimReleasePublishedPayload,
): ReadonlyArray<HotfixMatch> {
  const pins = collectServicePins(catalog, payload.service);
  if (pins === undefined) return [];

  const candidates: Array<{ target: "default" | "additional"; span: PinSpan }> = [
    { target: "default", span: pins.defaultPin },
    ...pins.additional.map((span) => ({ target: "additional" as const, span })),
  ];

  const matches: HotfixMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.span.version !== payload.upstream_version) continue;
    const text = catalog.slice(candidate.span.start, candidate.span.end);
    const revisionMatch = PIN_REVISION.exec(text);
    const currentRevision = revisionMatch === null ? -1 : Number(revisionMatch[1]);
    if (currentRevision < payload.revision) {
      matches.push({ target: candidate.target, currentRevision });
    }
  }
  return matches;
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

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Writes `pin` over `entry`'s span in `source`, or returns `source` unchanged when it already matches. */
function writePin(
  source: string,
  entry: Extract<SelectedEntry, { kind: "default" | "additional" }>,
  pin: ResolvedPin,
): { readonly source: string; readonly changed: boolean } {
  const desired = serializePin(pin);
  const current = source.slice(entry.span.start, entry.span.end);
  if (normalizeText(current) === normalizeText(desired)) return { source, changed: false };
  return {
    source: source.slice(0, entry.span.start) + desired + source.slice(entry.span.end),
    changed: true,
  };
}

/**
 * Rewrites `catalog` from Dockerfile tags that differ from `baseDockerfile`, pinning each to its
 * upstream's highest committed slim-services revision. With no base, every slim tag is in scope.
 * A pin that cannot be applied is reported in `skipped`. OrioleDB and a Dependabot bump older
 * than the current catalog pin are the non-blocking skips; the catalog is allowed to lead the
 * Dockerfile until Dependabot catches up.
 */
export async function planArtifactCatalogUpdate(input: {
  readonly dockerfile: string;
  readonly baseDockerfile?: string;
  readonly catalog: string;
  readonly io: RevisionIo;
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
        blocking: false,
      });
      continue;
    }

    const resolution = await resolveRevisionPin(pin.service, pin.version, input.io);
    if (resolution.status !== "resolved") {
      skipped.push({ alias: from.alias, reason: resolution.message, blocking: true });
      continue;
    }
    const written = writePin(source, entry, resolution.pin);
    if (!written.changed) continue;
    source = written.source;
    updates.push({
      service: pin.service,
      version: pin.version,
      revision: resolution.pin.revision,
      previousVersion: entry.version,
      target: entry.kind,
    });
  }

  return { source, updates, skipped };
}

export interface CatalogRefreshResult {
  readonly source: string;
  readonly update?: CatalogPinUpdate;
}

/**
 * Refreshes one catalog entry to the highest committed revision of `upstream` (or, when omitted,
 * of its currently pinned upstream version). Pure aside from `io`: callers own reading and
 * writing `Artifacts.ts`. This is what the manual CLI mode calls, and what a later hotfix pickup
 * workflow can call directly with `{service, upstream_version}` from its dispatch payload.
 */
export async function refreshCatalogPin(input: {
  readonly catalog: string;
  readonly service: string;
  readonly upstream?: string;
  readonly io: RevisionIo;
}): Promise<CatalogRefreshResult> {
  const entry = selectEntry(input.catalog, input.service, input.upstream);
  if (entry.kind === "unmodelled-service") {
    throw new InvalidPayloadError(`${CATALOG_PATH} has no slim entry for ${input.service}.`);
  }
  if (entry.kind === "unmodelled-release-line") {
    throw new InvalidPayloadError(
      `${input.service} ${input.upstream ?? ""} is not on a release line ${CATALOG_PATH} carries (${entry.known.join(", ")}).`,
    );
  }
  const upstream = input.upstream ?? entry.version;
  const resolution = await resolveRevisionPin(input.service, upstream, input.io);
  if (resolution.status !== "resolved") {
    throw new InvalidPayloadError(resolution.message);
  }
  const written = writePin(input.catalog, entry, resolution.pin);
  if (!written.changed) return { source: input.catalog };
  return {
    source: written.source,
    update: {
      service: input.service,
      version: upstream,
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
      const tagName = (item as { tag_name?: unknown } | null)?.tag_name;
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

function defaultRevisionIo(): RevisionIo {
  return { listReleaseTags, fetchChecksums, imageDigest, s3Sha256 };
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
      "Usage: sync-artifacts-catalog.ts --service <service> [--upstream <U>]",
    );
  }
  const catalogPath = CATALOG_PATH;
  const catalog = await Bun.file(catalogPath).text();
  const result = await refreshCatalogPin({
    catalog,
    service,
    upstream: flags.get("upstream"),
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

async function runHotfixMatches(argv: ReadonlyArray<string>): Promise<void> {
  const flags = parseFlags(argv);
  const service = flags.get("service");
  const upstream = flags.get("upstream");
  const revisionFlag = flags.get("revision");
  if (service === undefined || upstream === undefined || revisionFlag === undefined) {
    throw new InvalidPayloadError(
      "Usage: sync-artifacts-catalog.ts hotfix-matches --service <service> --upstream <U> --revision <N>",
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(revisionFlag)) {
    throw new InvalidPayloadError(`invalid --revision '${revisionFlag}'`);
  }
  const revision = Number(revisionFlag);
  const catalog = await Bun.file(CATALOG_PATH).text();
  const matches = findHotfixMatches(catalog, {
    service,
    upstream_version: upstream,
    revision,
    release_version: `${upstream}-r${revision}`,
  });
  console.log(JSON.stringify(matches));
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === "hotfix-matches") {
    await runHotfixMatches(argv.slice(1));
    return;
  }
  if (argv[0]?.startsWith("--") === true) {
    await runManual(argv);
    return;
  }

  const [dockerfilePath = DOCKERFILE_PATH, catalogPath = CATALOG_PATH, baseDockerfilePath] = argv;
  const dockerfile = await Bun.file(dockerfilePath).text();
  const catalog = await Bun.file(catalogPath).text();
  const baseDockerfile =
    baseDockerfilePath === undefined ? undefined : await Bun.file(baseDockerfilePath).text();
  const plan = await planArtifactCatalogUpdate({
    dockerfile,
    baseDockerfile,
    catalog,
    io: defaultRevisionIo(),
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
      `Pinned ${update.service} ${update.target} ${update.previousVersion} -> ${update.version} r${update.revision}.`,
    );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
