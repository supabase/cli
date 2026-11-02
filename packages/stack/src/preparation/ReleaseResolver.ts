import { Crypto, Effect, Option, Record, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import {
  artifactSourceService,
  type ArtifactKind,
  type ArtifactPin,
  type NativePin,
} from "../Artifacts.ts";
import { digestHex } from "./Integrity.ts";
import { SLIM_IMAGE_GHCR_REGISTRY, slimRegistryUrl, slimReleasesUrl } from "./SlimEndpoints.ts";
import {
  MIRROR_PRODUCERS,
  UPSTREAM_IMAGE_PATTERN,
  normalizeUpstreamImage,
  parseSha256Sums,
  type SlimNativeTarget,
} from "./SlimRelease.ts";

type NativeTarget = SlimNativeTarget;

const releaseFields = {
  service: Schema.String,
  upstream: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
  url: Schema.String,
  message: Schema.String,
};

/** The requested release, or every revision of the upstream version, is not published. */
export class ReleaseUnpublished extends Schema.TaggedError<ReleaseUnpublished>()(
  "ReleaseUnpublished",
  releaseFields,
) {}

/** A release host failed in a way a later attempt may resolve: transport, rate limit, or 5xx. */
export class ReleaseTransient extends Schema.TaggedError<ReleaseTransient>()("ReleaseTransient", {
  ...releaseFields,
  status: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** A published release is malformed or its bytes disagree with its own checksums or digest. */
export class ReleaseIntegrity extends Schema.TaggedError<ReleaseIntegrity>()("ReleaseIntegrity", {
  ...releaseFields,
  expected: Schema.optionalKey(Schema.String),
  actual: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type ReleaseError = ReleaseUnpublished | ReleaseTransient | ReleaseIntegrity;

export interface ResolvePinRequest {
  readonly service: ArtifactKind;
  /** Upstream version exactly as the release tag spells it. */
  readonly upstream: string;
  /** Exact revision to pin; the highest published one when omitted. */
  readonly revision?: number;
}

/** Revisions are allocated `0, 1, 2, …`; a host that never answers 404 must not loop forever. */
const MAX_PROBED_REVISIONS = 1000;

const REQUEST_TIMEOUT = "30 seconds";

const UPSTREAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const nativeManifestSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  target: Schema.String,
  upstream_image: Schema.optionalKey(Schema.String),
  source_image: Schema.optionalKey(Schema.String),
});

const provenanceSchema = Schema.Struct({ source: Schema.String });
const registryTokenSchema = Schema.Struct({ token: Schema.String });

interface Subject {
  readonly service: string;
  readonly upstream: string;
  readonly revision?: number;
}

const at = (subject: Subject, revision: number): Subject => ({ ...subject, revision });

const fieldsOf = (subject: Subject, url: string, message: string) => ({
  service: subject.service,
  upstream: subject.upstream,
  ...(subject.revision === undefined ? {} : { revision: subject.revision }),
  url,
  message,
});

const integrity = (
  subject: Subject,
  url: string,
  message: string,
  details: {
    readonly expected?: string;
    readonly actual?: string;
    readonly cause?: unknown;
  } = {},
) => new ReleaseIntegrity({ ...fieldsOf(subject, url, message), ...details });

interface Fetched {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly digestHeader: string | undefined;
}

const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Fetches one URL; every transport failure or timeout is `transient`, status classification is the caller's. */
const fetchResource = Effect.fnUntraced(function* (
  subject: Subject,
  url: string,
  headers: Record<string, string> = {},
) {
  const client = HttpClient.followRedirects(yield* HttpClient.HttpClient);
  const fetched = yield* Effect.gen(function* () {
    const response = yield* client.execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
    );
    const buffer = yield* response.arrayBuffer;
    return {
      status: response.status,
      bytes: new Uint8Array(buffer),
      digestHeader: Option.getOrUndefined(Headers.get(response.headers, "docker-content-digest")),
    } satisfies Fetched;
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new ReleaseTransient({
          ...fieldsOf(subject, url, `Unable to reach ${url}`),
          cause,
        }),
    ),
  );
  return fetched;
});

const isOk = (status: number): boolean => status >= 200 && status < 300;

const unexpectedStatus = (subject: Subject, url: string, status: number) =>
  new ReleaseTransient({
    ...fieldsOf(subject, url, `HTTP ${status} from ${url}`),
    status,
  });

const sha256Hex = Effect.fnUntraced(function* (subject: Subject, url: string, bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return digestHex(
    yield* crypto
      .digest("SHA-256", bytes)
      .pipe(
        Effect.mapError((cause) =>
          integrity(subject, url, `Unable to compute SHA-256: ${String(cause)}`),
        ),
      ),
  );
});

const decodeJson = <S extends Schema.Decoder<unknown>>(
  schema: S,
  subject: Subject,
  url: string,
  what: string,
  bytes: Uint8Array,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(decodeText(bytes)).pipe(
    Effect.mapError((cause) => integrity(subject, url, `${what} is malformed`, { cause })),
  );

/** A release's `SHA256SUMS`, keyed by asset basename. */
const parseSums = (subject: Subject, url: string, text: string) => {
  const parsed = parseSha256Sums(text);
  return parsed.kind === "sums"
    ? Effect.succeed(parsed.sums)
    : Effect.fail(
        integrity(subject, url, parsed.message, {
          ...(parsed.expected === undefined ? {} : { expected: parsed.expected }),
          ...(parsed.actual === undefined ? {} : { actual: parsed.actual }),
        }),
      );
};

interface Published {
  readonly revision: number;
  readonly url: string;
  readonly sums: string;
}

const probeRelease = Effect.fnUntraced(function* (
  subject: Subject,
  releasesUrl: string,
  producer: string,
  revision: number,
) {
  const url = `${releasesUrl}/${producer}-${subject.upstream}-r${revision}/SHA256SUMS`;
  const probed = at(subject, revision);
  const fetched = yield* fetchResource(probed, url);
  if (fetched.status === 404) return undefined;
  if (!isOk(fetched.status)) return yield* unexpectedStatus(probed, url, fetched.status);
  return { revision, url, sums: decodeText(fetched.bytes) } satisfies Published;
});

/** The `SHA256SUMS` of the revision to pin, and how many releases were probed to find it. */
const findRevision = Effect.fn("ReleaseResolver.findRevision")(function* (
  subject: Subject,
  releasesUrl: string,
  producer: string,
) {
  if (subject.revision !== undefined) {
    const found = yield* probeRelease(subject, releasesUrl, producer, subject.revision);
    yield* Effect.annotateCurrentSpan({ "release.probes": 1 });
    if (found === undefined)
      return yield* new ReleaseUnpublished(
        fieldsOf(
          subject,
          `${releasesUrl}/${producer}-${subject.upstream}-r${subject.revision}/SHA256SUMS`,
          `${producer}-${subject.upstream}-r${subject.revision} is not a published release`,
        ),
      );
    return found;
  }
  // The first 404 ends the sequence: revisions are contiguous (ADR 0026, "Immutable revisions").
  let latest: Published | undefined;
  let probes = 0;
  let ended = false;
  while (!ended && probes < MAX_PROBED_REVISIONS) {
    const found = yield* probeRelease(subject, releasesUrl, producer, probes);
    probes += 1;
    if (found === undefined) ended = true;
    else latest = found;
  }
  yield* Effect.annotateCurrentSpan({
    "release.probes": probes,
    ...(latest === undefined ? {} : { "release.revision": latest.revision }),
  });
  if (latest === undefined)
    return yield* new ReleaseUnpublished(
      fieldsOf(
        subject,
        `${releasesUrl}/${producer}-${subject.upstream}-r0/SHA256SUMS`,
        `${producer} has no published release of ${subject.upstream}`,
      ),
    );
  if (!ended)
    return yield* integrity(
      subject,
      latest.url,
      `${producer}-${subject.upstream} lists ${MAX_PROBED_REVISIONS} revisions without ending`,
    );
  return latest;
});

const validUpstreamImage = (subject: Subject, url: string, image: string) =>
  UPSTREAM_IMAGE_PATTERN.test(image)
    ? Effect.succeed(image)
    : Effect.fail(integrity(subject, url, `Release names an invalid upstream image: ${image}`));

/** Verifies one target's manifest against its release checksum and returns its pin. */
const verifyTarget = Effect.fnUntraced(function* (
  subject: Subject,
  sumsUrl: string,
  releaseBase: string,
  releaseVersion: string,
  producer: string,
  sums: ReadonlyMap<string, string>,
  target: NativeTarget,
) {
  const stem = `${producer}-${releaseVersion}-${target}`;
  const archive = sums.get(`${stem}.tar.zst`);
  const manifest = sums.get(`${stem}.manifest.json`);
  if (archive === undefined || manifest === undefined)
    return yield* integrity(
      subject,
      sumsUrl,
      `SHA256SUMS has no entry for ${archive === undefined ? `${stem}.tar.zst` : `${stem}.manifest.json`}`,
    );
  const url = `${releaseBase}/${stem}.manifest.json`;
  const fetched = yield* fetchResource(subject, url);
  if (fetched.status === 404)
    return yield* integrity(subject, url, `Published release has no ${stem}.manifest.json`);
  if (!isOk(fetched.status)) return yield* unexpectedStatus(subject, url, fetched.status);
  const actual = yield* sha256Hex(subject, url, fetched.bytes);
  if (actual !== manifest)
    return yield* integrity(subject, url, "Manifest does not match SHA256SUMS", {
      expected: manifest,
      actual,
    });
  const decoded = yield* decodeJson(nativeManifestSchema, subject, url, "Manifest", fetched.bytes);
  if (
    decoded.service !== producer ||
    decoded.version !== releaseVersion ||
    decoded.target !== target
  )
    return yield* integrity(subject, url, "Manifest describes a different release or target");
  return {
    pin: { archive, manifest } satisfies NativePin,
    upstreamImage: decoded.upstream_image ?? decoded.source_image,
  };
});

const resolveUpstreamImage = Effect.fn("ReleaseResolver.resolveUpstreamImage")(function* (
  subject: Subject,
  releaseBase: string,
  producer: string,
  sums: ReadonlyMap<string, string>,
  manifestImages: ReadonlyArray<string | undefined>,
) {
  if (MIRROR_PRODUCERS.has(producer)) {
    const name = `${producer}-${subject.upstream}.oci-provenance.json`;
    const url = `${releaseBase}/${name}`;
    yield* Effect.annotateCurrentSpan({ "release.upstream_image_source": "provenance" });
    const expected = sums.get(name);
    if (expected === undefined)
      return yield* integrity(subject, url, `SHA256SUMS has no entry for ${name}`);
    const fetched = yield* fetchResource(subject, url);
    if (fetched.status === 404)
      return yield* integrity(subject, url, "Published release has no oci-provenance file");
    if (!isOk(fetched.status)) return yield* unexpectedStatus(subject, url, fetched.status);
    const actual = yield* sha256Hex(subject, url, fetched.bytes);
    if (actual !== expected)
      return yield* integrity(subject, url, "oci-provenance does not match SHA256SUMS", {
        expected,
        actual,
      });
    const { source } = yield* decodeJson(
      provenanceSchema,
      subject,
      url,
      "oci-provenance",
      fetched.bytes,
    );
    return yield* validUpstreamImage(subject, url, normalizeUpstreamImage(source));
  }
  yield* Effect.annotateCurrentSpan({ "release.upstream_image_source": "manifests" });
  const images = new Set(
    manifestImages.map((image) =>
      image === undefined ? undefined : normalizeUpstreamImage(image),
    ),
  );
  const [only] = images;
  if (images.size !== 1 || only === undefined)
    return yield* integrity(
      subject,
      releaseBase,
      "Target manifests do not agree on one upstream image",
    );
  return yield* validUpstreamImage(subject, releaseBase, only);
});

/** The registry's digest of the slim image tag: the manifest body's sha256, checked against the registry's header. */
const imageDigest = Effect.fn("ReleaseResolver.imageDigest")(function* (
  subject: Subject,
  registryUrl: string,
  producer: string,
  tag: string,
) {
  const repository = `supabase/cli/${producer}`;
  const tokenUrl = `${registryUrl}/token?scope=repository:${repository}:pull`;
  const tokenResponse = yield* fetchResource(subject, tokenUrl);
  if (!isOk(tokenResponse.status))
    return yield* unexpectedStatus(subject, tokenUrl, tokenResponse.status);
  const { token } = yield* decodeJson(
    registryTokenSchema,
    subject,
    tokenUrl,
    "Registry token",
    tokenResponse.bytes,
  );
  const url = `${registryUrl}/v2/${repository}/manifests/${tag}`;
  const fetched = yield* fetchResource(subject, url, {
    Authorization: `Bearer ${token}`,
    Accept: MANIFEST_ACCEPT,
  });
  if (fetched.status === 404)
    return yield* integrity(subject, url, `Published release has no image ${repository}:${tag}`);
  if (!isOk(fetched.status)) return yield* unexpectedStatus(subject, url, fetched.status);
  const actual = `sha256:${yield* sha256Hex(subject, url, fetched.bytes)}`;
  if (fetched.digestHeader !== undefined && fetched.digestHeader !== actual)
    return yield* integrity(subject, url, "Registry digest does not match the manifest body", {
      expected: fetched.digestHeader,
      actual,
    });
  return actual;
});

/**
 * Resolves the content pin of a published slim-services release: the highest revision of
 * `upstream`, or exactly `revision`. The pin carries the same fields the compiled catalog does.
 */
export const resolvePin = Effect.fn("ReleaseResolver.resolvePin")(
  function* (request: ResolvePinRequest) {
    const subject: Subject = { service: request.service, upstream: request.upstream };
    const producer = artifactSourceService(request.service);
    yield* Effect.annotateCurrentSpan({
      "release.service": request.service,
      "release.upstream": request.upstream,
    });
    const revisionValid =
      request.revision === undefined ||
      (Number.isSafeInteger(request.revision) && request.revision >= 0);
    if (!UPSTREAM_PATTERN.test(request.upstream) || !revisionValid)
      return yield* new ReleaseUnpublished(
        fieldsOf(
          subject,
          "",
          `${request.upstream}${request.revision === undefined ? "" : `-r${request.revision}`} cannot name a release`,
        ),
      );
    const releasesUrl = yield* slimReleasesUrl;
    const registryUrl = yield* slimRegistryUrl;
    const found = yield* findRevision(
      request.revision === undefined ? subject : at(subject, request.revision),
      releasesUrl,
      producer,
    );
    const resolved = at(subject, found.revision);
    const releaseVersion = `${request.upstream}-r${found.revision}`;
    const releaseBase = `${releasesUrl}/${producer}-${releaseVersion}`;
    const sums = yield* parseSums(resolved, found.url, found.sums);
    const verify = (target: NativeTarget) =>
      verifyTarget(resolved, found.url, releaseBase, releaseVersion, producer, sums, target);
    const targets = yield* Effect.all(
      {
        "darwin-arm64": verify("darwin-arm64"),
        "linux-amd64": verify("linux-amd64"),
        "linux-arm64": verify("linux-arm64"),
      } satisfies Record<NativeTarget, unknown>,
      { concurrency: "unbounded" },
    ).pipe(Effect.withSpan("ReleaseResolver.verifyNatives"));
    const upstreamImage = yield* resolveUpstreamImage(
      resolved,
      releaseBase,
      producer,
      sums,
      Object.values(targets).map((target) => target.upstreamImage),
    );
    const digest = yield* imageDigest(resolved, registryUrl, producer, releaseVersion);
    yield* Effect.annotateCurrentSpan({
      "release.revision": found.revision,
      "release.outcome": "resolved",
    });
    return {
      upstreamVersion: request.upstream,
      revision: found.revision,
      image: `${SLIM_IMAGE_GHCR_REGISTRY}${producer}:${releaseVersion}@${digest}`,
      upstreamImage,
      natives: Record.map(targets, (target) => target.pin),
    } satisfies ArtifactPin;
  },
  Effect.tapError((error) => Effect.annotateCurrentSpan({ "release.outcome": error._tag })),
);
