/* oxlint-disable effecttsgo/global-console, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/new-promise -- standalone Bun dev script for the output gallery, not CLI runtime code */
/* Serves the gallery page without caching, so a reload always shows the latest capture.
   Usage: bun scripts/gallery-serve.ts <gallery-dir> [port] */
import { join, normalize } from "node:path";

const [galleryDir, portArg] = process.argv.slice(2);
if (!galleryDir) {
  console.error("usage: bun scripts/gallery-serve.ts <gallery-dir> [port]");
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(portArg) || 8787,
  fetch(request) {
    const path = normalize(new URL(request.url).pathname).replace(/^(\.\.[/\\])+/, "");
    const file = Bun.file(join(galleryDir, path === "/" ? "index.html" : path));
    return file
      .exists()
      .then((found) =>
        found
          ? new Response(file, { headers: { "Cache-Control": "no-store" } })
          : new Response("Not found", { status: 404 }),
      );
  },
});
console.log(`gallery at http://${server.hostname}:${server.port}/`);
