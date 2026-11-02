import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Crypto, Effect, Layer, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the fixture owns a local native listener.
import { createServer, type Server } from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the fixture owns a local native listener.
import { createServer as createTcpServer, type Server as NetServer } from "node:net";
import type { ArtifactKind } from "../Artifacts.ts";
import { digestHex } from "./Integrity.ts";
import { resolvePin } from "./ReleaseResolver.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;

interface Served {
  readonly body: string;
  readonly headers?: Record<string, string>;
}

interface Request {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
}

interface Fixture {
  readonly origin: string;
  readonly routes: Map<string, Served>;
  /** Paths answered with a bare status instead of their route. */
  readonly failing: Map<string, number>;
  readonly requests: Array<Request>;
}

/** A release host and registry on one OS-assigned loopback port: `/releases/…`, `/token`, `/v2/…`. */
const startFixture = Effect.acquireRelease(
  Effect.callback<{ server: Server; fixture: Fixture }>((resume) => {
    const routes = new Map<string, Served>([["/token", { body: toJson({ token: "anon" }) }]]);
    const failing = new Map<string, number>();
    const requests: Array<Request> = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      requests.push({
        path,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
      });
      const status = failing.get(path);
      const served = routes.get(path);
      if (status !== undefined) response.statusCode = status;
      else if (path.startsWith("/v2/") && request.headers.authorization !== "Bearer anon")
        response.statusCode = 401;
      else if (served === undefined) response.statusCode = 404;
      else
        for (const [name, value] of Object.entries(served.headers ?? {}))
          response.setHeader(name, value);
      response.end(status === undefined ? (served?.body ?? "") : "");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return;
      resume(
        Effect.succeed({
          server,
          fixture: { origin: `http://127.0.0.1:${address.port}`, routes, failing, requests },
        }),
      );
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    }),
).pipe(Effect.map(({ fixture }) => fixture));

/** A loopback TCP listener that accepts every connection and resets it before any HTTP reply. */
const startResettingListener = Effect.acquireRelease(
  Effect.callback<{ origin: string; server: NetServer }>((resume) => {
    const server = createTcpServer((socket) => socket.resetAndDestroy());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return;
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${address.port}`,
          server,
        }),
      );
    });
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
).pipe(Effect.map(({ origin }) => origin));

const sha256Of = Effect.fn(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  return digestHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(text)));
});

interface Publication {
  readonly producer: string;
  readonly upstream: string;
  readonly revision: number;
  /** Serves different manifest bytes than the ones SHA256SUMS lists. */
  readonly tamperedManifest?: boolean;
  readonly omitSumsEntryFor?: string;
  /** Lists a digest that is not 64 lowercase hexadecimal characters. */
  readonly malformedDigest?: boolean;
  /** The manifest asset of this stem is listed in SHA256SUMS but answers 404. */
  readonly missingManifestAsset?: string;
  readonly omitProvenanceFromSums?: boolean;
  /** Serves different provenance bytes than the ones SHA256SUMS lists. */
  readonly tamperedProvenance?: boolean;
  readonly omitImage?: boolean;
  /** Registry `Docker-Content-Digest` that differs from the manifest body. */
  readonly imageDigestHeader?: string;
  readonly provenanceSource?: string;
}

/** Publishes one release to the fixture the way slim-services lays it out, and returns its content. */
const publish = Effect.fn(function* (fixture: Fixture, release: Publication) {
  const releaseVersion = `${release.upstream}-r${release.revision}`;
  const tag = `${release.producer}-${releaseVersion}`;
  const sums: Array<string> = [];
  const natives: Record<string, { archive: string; manifest: string }> = {};
  for (const target of TARGETS) {
    const stem = `${tag}-${target}`;
    const image = `docker.io/upstream/${release.producer}:${release.upstream}@sha256:${"a".repeat(64)}`;
    const manifest = toJson({
      service: release.producer,
      version: releaseVersion,
      target,
      ...(target === "darwin-arm64" ? { upstream_image: image } : { source_image: image }),
    });
    const archive = `archive ${stem}`;
    natives[target] = { archive: yield* sha256Of(archive), manifest: yield* sha256Of(manifest) };
    if (release.omitSumsEntryFor !== stem) {
      sums.push(`${natives[target].archive}  ${stem}.tar.zst`);
      sums.push(`${natives[target].manifest}  ${stem}.manifest.json`);
    }
    if (release.missingManifestAsset !== stem)
      fixture.routes.set(`/releases/${tag}/${stem}.manifest.json`, {
        body: release.tamperedManifest === true ? `${manifest} ` : manifest,
      });
  }
  if (release.provenanceSource !== undefined) {
    const provenanceName = `${release.producer}-${release.upstream}.oci-provenance.json`;
    const provenance = toJson({ source: release.provenanceSource });
    if (release.omitProvenanceFromSums !== true)
      sums.push(`${yield* sha256Of(provenance)}  ${provenanceName}`);
    fixture.routes.set(`/releases/${tag}/${provenanceName}`, {
      body: release.tamperedProvenance === true ? `${provenance} ` : provenance,
    });
  }
  if (release.malformedDigest === true)
    sums.push(`${"g".repeat(64)}  ${release.producer}-bad.tar.zst`);
  fixture.routes.set(`/releases/${tag}/SHA256SUMS`, { body: `${sums.join("\n")}\n` });
  const imageManifest = toJson({ schemaVersion: 2, tag });
  const digest = `sha256:${yield* sha256Of(imageManifest)}`;
  if (release.omitImage !== true)
    fixture.routes.set(`/v2/supabase/cli/${release.producer}/manifests/${releaseVersion}`, {
      body: imageManifest,
      headers: { "docker-content-digest": release.imageDigestHeader ?? digest },
    });
  return { natives, digest };
});

/** Runs `effect` with the fixture standing in for GitHub releases and GHCR, through the env override. */
const against = <A, E, R>(fixture: Fixture, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerNodeHttp,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              SUPABASE_INTERNAL_SLIM_RELEASES_URL: `${fixture.origin}/releases/`,
              SUPABASE_INTERNAL_SLIM_REGISTRY_URL: fixture.origin,
            },
          }),
        ),
      ),
    ),
  );

const sumsRequests = (fixture: Fixture): ReadonlyArray<string> =>
  fixture.requests.map(({ path }) => path).filter((path) => path.endsWith("/SHA256SUMS"));

describe("release resolver", () => {
  it.live("pins the highest published revision with the content of that release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        yield* publish(fixture, { producer: "postgrest", upstream: "v99.0.0", revision: 0 });
        yield* publish(fixture, { producer: "postgrest", upstream: "v99.0.0", revision: 1 });
        const latest = yield* publish(fixture, {
          producer: "postgrest",
          upstream: "v99.0.0",
          revision: 2,
        });

        const pin = yield* against(fixture, resolvePin({ service: "rest", upstream: "v99.0.0" }));

        expect(pin).toEqual({
          upstreamVersion: "v99.0.0",
          revision: 2,
          image: `ghcr.io/supabase/cli/postgrest:v99.0.0-r2@${latest.digest}`,
          upstreamImage: "upstream/postgrest:v99.0.0",
          natives: latest.natives,
        });
        expect(sumsRequests(fixture)).toEqual(
          [0, 1, 2, 3].map((revision) => `/releases/postgrest-v99.0.0-r${revision}/SHA256SUMS`),
        );
        const manifestRequest = fixture.requests.find(({ path }) => path.includes("/manifests/"));
        expect(manifestRequest?.authorization).toBe("Bearer anon");
        expect(manifestRequest?.accept).toContain("application/vnd.oci.image.index.v1+json");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("pins exactly the requested revision, not the highest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        const first = yield* publish(fixture, {
          producer: "auth",
          upstream: "v2.1.0",
          revision: 0,
        });
        yield* publish(fixture, { producer: "auth", upstream: "v2.1.0", revision: 1 });

        const pin = yield* against(
          fixture,
          resolvePin({ service: "auth", upstream: "v2.1.0", revision: 0 }),
        );

        expect(pin.revision).toBe(0);
        expect(pin.natives).toEqual(first.natives);
        expect(pin.image).toBe(`ghcr.io/supabase/cli/auth:v2.1.0-r0@${first.digest}`);
        expect(sumsRequests(fixture)).toEqual(["/releases/auth-v2.1.0-r0/SHA256SUMS"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reads a mirrored service's upstream image from its provenance file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        yield* publish(fixture, {
          producer: "mailpit",
          upstream: "v1.31.0",
          revision: 0,
          provenanceSource: "docker.io/axllent/mailpit:v1.31.0@sha256:" + "b".repeat(64),
        });

        const pin = yield* against(fixture, resolvePin({ service: "mail", upstream: "v1.31.0" }));

        expect(pin.upstreamImage).toBe("axllent/mailpit:v1.31.0");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reports a release that is not published as unpublished", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        yield* publish(fixture, { producer: "storage", upstream: "v1.0.0", revision: 0 });

        const none = yield* against(
          fixture,
          resolvePin({ service: "storage", upstream: "v9.9.9" }).pipe(Effect.flip),
        );
        const missingRevision = yield* against(
          fixture,
          resolvePin({ service: "storage", upstream: "v1.0.0", revision: 3 }).pipe(Effect.flip),
        );

        expect(none).toMatchObject({
          _tag: "ReleaseUnpublished",
          service: "storage",
          upstream: "v9.9.9",
          url: `${fixture.origin}/releases/storage-v9.9.9-r0/SHA256SUMS`,
        });
        expect(missingRevision).toMatchObject({
          _tag: "ReleaseUnpublished",
          upstream: "v1.0.0",
          revision: 3,
          url: `${fixture.origin}/releases/storage-v1.0.0-r3/SHA256SUMS`,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live.each([
    { status: 500, path: "/releases/realtime-v2.0.0-r0/SHA256SUMS", revision: undefined },
    { status: 429, path: "/releases/realtime-v2.0.0-r0/SHA256SUMS", revision: undefined },
    { status: 403, path: "/releases/realtime-v2.0.0-r0/SHA256SUMS", revision: undefined },
    // Registry outage after a healthy release is transient as well.
    { status: 503, path: "/token", revision: 0 },
  ])("treats HTTP $status from $path as transient, never as unpublished", (row) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        yield* publish(fixture, { producer: "realtime", upstream: "v2.0.0", revision: 0 });
        fixture.failing.set(row.path, row.status);

        const error = yield* against(
          fixture,
          resolvePin({
            service: "realtime",
            upstream: "v2.0.0",
            ...(row.revision === undefined ? {} : { revision: row.revision }),
          }).pipe(Effect.flip),
        );

        expect(error).toMatchObject({
          _tag: "ReleaseTransient",
          status: row.status,
          url: expect.stringContaining(row.path),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reports a connection that is reset as transient", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resetting = yield* startResettingListener;

        const error = yield* against(
          { origin: resetting, routes: new Map(), failing: new Map(), requests: [] },
          resolvePin({ service: "realtime", upstream: "v2.0.0" }).pipe(Effect.flip),
        );

        expect(error).toMatchObject({
          _tag: "ReleaseTransient",
          url: expect.stringContaining(resetting),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live.each([
    { name: "r0 and r1 published, r2 absent", published: [0, 1], expected: 1 },
    { name: "a gap at r1 ends the sequence at r0", published: [0, 2], expected: 0 },
  ])("pins the last revision before the first 404 when $name", (row) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        for (const revision of row.published)
          yield* publish(fixture, { producer: "pgmeta", upstream: "v1.0.0", revision });

        const pin = yield* against(fixture, resolvePin({ service: "pgmeta", upstream: "v1.0.0" }));

        expect(pin.revision).toBe(row.expected);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  const mirrored = {
    provenanceSource: `docker.io/axllent/mailpit:v1.0.0@sha256:${"b".repeat(64)}`,
  };

  it.live.each<{
    readonly name: string;
    readonly service: ArtifactKind;
    readonly producer: string;
    readonly release: Partial<Publication>;
    readonly message: RegExp;
    readonly digests?: "expected-hash" | "registry-header";
  }>([
    {
      name: "manifest hash mismatch",
      service: "auth",
      producer: "auth",
      release: { tamperedManifest: true },
      message: /does not match SHA256SUMS/u,
      digests: "expected-hash",
    },
    {
      name: "malformed SHA256SUMS digest",
      service: "auth",
      producer: "auth",
      release: { malformedDigest: true },
      message: /SHA256SUMS contains a malformed line/u,
    },
    {
      name: "target missing from SHA256SUMS",
      service: "pgmeta",
      producer: "pgmeta",
      release: { omitSumsEntryFor: "pgmeta-v1.0.0-r0-linux-arm64" },
      message: /no entry for pgmeta-v1.0.0-r0-linux-arm64.tar.zst/u,
    },
    {
      name: "manifest asset listed in SHA256SUMS but absent from the release",
      service: "storage",
      producer: "storage",
      release: { missingManifestAsset: "storage-v1.0.0-r0-linux-amd64" },
      message: /no storage-v1.0.0-r0-linux-amd64.manifest.json/u,
    },
    {
      name: "registry digest header differs from the manifest body",
      service: "studio",
      producer: "studio",
      release: { imageDigestHeader: `sha256:${"c".repeat(64)}` },
      message: /Registry digest does not match/u,
      digests: "registry-header",
    },
    {
      name: "slim image absent from the registry",
      service: "analytics",
      producer: "analytics",
      release: { omitImage: true },
      message: /has no image supabase\/cli\/analytics:v1.0.0-r0/u,
    },
    {
      name: "provenance file hash mismatch",
      service: "mail",
      producer: "mailpit",
      release: { ...mirrored, tamperedProvenance: true },
      message: /oci-provenance does not match SHA256SUMS/u,
      digests: "expected-hash",
    },
    {
      name: "provenance file missing from SHA256SUMS",
      service: "mail",
      producer: "mailpit",
      release: { ...mirrored, omitProvenanceFromSums: true },
      message: /no entry for mailpit-v1.0.0.oci-provenance.json/u,
    },
  ])("rejects a release with $name", (row) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture;
        yield* publish(fixture, {
          producer: row.producer,
          upstream: "v1.0.0",
          revision: 0,
          ...row.release,
        });

        const error = yield* against(
          fixture,
          resolvePin({ service: row.service, upstream: "v1.0.0", revision: 0 }).pipe(Effect.flip),
        );

        expect(error).toMatchObject({
          _tag: "ReleaseIntegrity",
          service: row.service,
          upstream: "v1.0.0",
          revision: 0,
          message: expect.stringMatching(row.message),
        });
        if (row.digests === "expected-hash")
          expect(error).toMatchObject({ expected: expect.stringMatching(/^[0-9a-f]{64}$/u) });
        if (row.digests === "registry-header")
          expect(error).toMatchObject({ expected: `sha256:${"c".repeat(64)}` });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
