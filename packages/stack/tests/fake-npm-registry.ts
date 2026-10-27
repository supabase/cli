import { createHash } from "node:crypto";
import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { gzipSync } from "node:zlib";
import { Effect } from "effect";

const tarFile = (name: string, content: string): Uint8Array => {
  const body = new TextEncoder().encode(content);
  const bytes = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  const header = bytes.subarray(0, 512);
  header.set(new TextEncoder().encode(name), 0);
  header.set(new TextEncoder().encode("0000644\0"), 100);
  header.set(new TextEncoder().encode("0000000\0"), 108);
  header.set(new TextEncoder().encode("0000000\0"), 116);
  header.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar\0"), 257);
  header.fill(32, 148, 156);
  const checksum = header
    .reduce((sum, value) => sum + value, 0)
    .toString(8)
    .padStart(6, "0");
  header.set(new TextEncoder().encode(`${checksum}\0 `), 148);
  bytes.set(body, 512);
  return bytes;
};

const packageTarball = (name: string, version: string, source: string): Uint8Array => {
  const manifest = JSON.stringify({ name, version, type: "module", main: "index.js" });
  const files = [
    tarFile("package/package.json", manifest),
    tarFile("package/index.js", source),
    new Uint8Array(1024),
  ];
  return gzipSync(Buffer.concat(files));
};

/**
 * A loopback npm registry serving one ESM package, `source` as its `index.js`, and counting how
 * many times its tarball is downloaded.
 */
export const makeFakeNpmRegistry = (pkg: {
  readonly name: string;
  readonly version: string;
  readonly source: string;
}) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly server: ReturnType<typeof createServer>;
      readonly counts: { tarballs: number };
    }>((resume) => {
      const tarball = packageTarball(pkg.name, pkg.version, pkg.source);
      const shasum = createHash("sha1").update(tarball).digest("hex");
      const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
      const tarballPath = `/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
      const counts = { tarballs: 0 };
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://registry").pathname;
        if (path === `/${pkg.name}`) {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              name: pkg.name,
              "dist-tags": { latest: pkg.version },
              versions: {
                [pkg.version]: {
                  name: pkg.name,
                  version: pkg.version,
                  dist: {
                    tarball: `http://${request.headers.host}${tarballPath}`,
                    shasum,
                    integrity,
                  },
                },
              },
            }),
          );
        } else if (path === tarballPath) {
          counts.tarballs++;
          response.setHeader("content-type", "application/octet-stream");
          response.end(tarball);
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          return resume(Effect.die("fake npm registry has no address"));
        resume(Effect.succeed({ url: `http://127.0.0.1:${address.port}/`, server, counts }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map(({ url, counts }) => ({
      url,
      tarballFetches: Effect.sync(() => counts.tarballs),
    })),
  );
