import type { WorkerRuntime } from "./worker-runtimes.ts";

/**
 * The starter files `supabase workers new` writes, per runtime.
 *
 * Held as source text rather than read from a directory on disk, the same way
 * `supabase functions new` holds its entrypoint: the compiled binary ships no
 * template tree, so the content has to travel in the module graph.
 *
 * The catalog runtimes all scaffold a Web-standard `fetch` handler (or, for
 * python, an ASGI `app`) rather than binding a port themselves — the base
 * image's own entrypoint does the binding in production.
 */

const packageJson = `${JSON.stringify(
  {
    name: "worker",
    private: true,
    type: "module",
  },
  null,
  2,
)}\n`;

const fetchHandler = (
  runtime: string,
) => `// Starter for the "${runtime}" runtime — edit before deploying.
// Export a default object with a Web-standard \`fetch\` handler; the runtime
// binds the port and serves it.
export default {
  fetch() {
    return new Response("hello from supabase workers\\n");
  },
};
`;

const dockerfile = `FROM node:24-alpine
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
`;

/**
 * Scaffolded alongside the Dockerfile above, because that Dockerfile's \`CMD\`
 * names it. A starter whose only file references a second file that does not
 * exist builds cleanly and then crash-loops on deploy — the one runtime whose
 * scaffold could not run as written.
 */
const dockerfileServer = `// Starter for the "dockerfile" runtime — edit before deploying.
// The Dockerfile's CMD runs this file; it binds the port itself, unlike the
// catalog runtimes where the base image does the binding.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("hello from supabase workers\\n");
}).listen(port, () => {
  console.log(\`listening on \${port}\`);
});
`;

const pythonApp = `# Starter for the "python" runtime — edit before deploying.
# \`app\` is an ASGI application, so FastAPI/Starlette/etc. work too — just
# assign your app to \`app\`. The runtime serves it on the ingress port.
async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/plain")],
    })
    await send({"type": "http.response.body", "body": b"hello from supabase workers\\n"})
`;

const pythonRequirements = `# add your dependencies here
`;

const sandboxReadme = `# sandbox

A bare sandbox runtime — no HTTP handler and no baked code. It is an environment
to run things in, not a served app, so \`supabase workers push\` here provisions
the environment and gives it no URL.
`;

/** Each runtime's starter files, keyed by the filename to write in the worker directory. */
export const WORKER_STACKS: Record<WorkerRuntime, Readonly<Record<string, string>>> = {
  // `package.json` is scaffolded for its `"type": "module"` alone: without it
  // `server.js` is only ESM by Node's syntax detection, which is a heuristic to
  // rely on for a file the image's CMD depends on.
  dockerfile: {
    Dockerfile: dockerfile,
    "package.json": packageJson,
    "server.js": dockerfileServer,
  },
  node: { "package.json": packageJson, "index.js": fetchHandler("node") },
  bun: { "package.json": packageJson, "index.ts": fetchHandler("bun") },
  deno: { "main.ts": fetchHandler("deno") },
  python: { "main.py": pythonApp, "requirements.txt": pythonRequirements },
  sandbox: { "README.md": sandboxReadme },
};
