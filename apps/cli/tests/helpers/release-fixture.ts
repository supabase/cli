import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the fixture owns a local native listener.
import { createServer } from "node:http";
import { Effect } from "effect";

const TARGETS = ["darwin-arm64", "linux-amd64", "linux-arm64"] as const;

interface Served {
  readonly body: string;
  readonly headers?: Record<string, string>;
}

/** A slim-services release host and registry on one loopback port. */
export interface ReleaseFixture {
  readonly origin: string;
  readonly routes: Map<string, Served>;
  /** HTTP status to answer a path with instead of its route. */
  readonly failing: Map<string, number>;
  /** The path of every request received, in arrival order. */
  readonly requests: Array<string>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Serves `/releases/…`, `/token` and `/v2/…` from OS-assigned loopback port until the scope closes. */
export const startReleaseFixture = Effect.acquireRelease(
  Effect.callback<{ close: () => Promise<void>; fixture: ReleaseFixture }>((resume) => {
    const routes = new Map<string, Served>([
      ["/token", { body: JSON.stringify({ token: "anon" }) }],
    ]);
    const failing = new Map<string, number>();
    const requests: Array<string> = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      requests.push(path);
      const served = routes.get(path);
      const status = failing.get(path);
      if (status !== undefined) response.statusCode = status;
      else if (path.startsWith("/v2/") && request.headers.authorization !== "Bearer anon")
        response.statusCode = 401;
      else if (served === undefined) response.statusCode = 404;
      else
        for (const [name, value] of Object.entries(served.headers ?? {}))
          response.setHeader(name, value);
      response.end(served?.body ?? "");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return;
      resume(
        Effect.succeed({
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
          fixture: { origin: `http://127.0.0.1:${address.port}`, routes, failing, requests },
        }),
      );
    });
  }),
  ({ close }) => Effect.promise(close),
).pipe(Effect.map(({ fixture }) => fixture));

/** The env that points the stack's release resolver at `fixture`. */
export const releaseHostEnv = (fixture: ReleaseFixture) => ({
  SUPABASE_INTERNAL_SLIM_RELEASES_URL: `${fixture.origin}/releases/`,
  SUPABASE_INTERNAL_SLIM_REGISTRY_URL: fixture.origin,
});

/** Publishes `<producer>-<upstream>-r<revision>` the way slim-services lays it out; returns its image digest. */
export const publishRelease = (
  fixture: ReleaseFixture,
  release: {
    producer: string;
    upstream: string;
    revision: number;
    /** Serves manifests that no longer match their `SHA256SUMS` entries. */
    tamperedManifest?: boolean;
  },
) => {
  const version = `${release.upstream}-r${release.revision}`;
  const tag = `${release.producer}-${version}`;
  const sums: Array<string> = [];
  for (const target of TARGETS) {
    const stem = `${tag}-${target}`;
    const image = `docker.io/upstream/${release.producer}:${release.upstream}@sha256:${"a".repeat(64)}`;
    const manifest = JSON.stringify({
      service: release.producer,
      version,
      target,
      ...(target === "darwin-arm64" ? { upstream_image: image } : { source_image: image }),
    });
    sums.push(`${sha256(`archive ${stem}`)}  ${stem}.tar.zst`);
    sums.push(`${sha256(manifest)}  ${stem}.manifest.json`);
    fixture.routes.set(`/releases/${tag}/${stem}.manifest.json`, {
      body: release.tamperedManifest === true ? `${manifest} ` : manifest,
    });
  }
  fixture.routes.set(`/releases/${tag}/SHA256SUMS`, { body: `${sums.join("\n")}\n` });
  const imageManifest = JSON.stringify({ schemaVersion: 2, tag });
  const digest = `sha256:${sha256(imageManifest)}`;
  fixture.routes.set(`/v2/supabase/cli/${release.producer}/manifests/${version}`, {
    body: imageManifest,
    headers: { "docker-content-digest": digest },
  });
  return { digest };
};
