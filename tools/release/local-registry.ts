/**
 * Starts a local Verdaccio npm registry for testing CLI releases.
 *
 * Usage: pnpm local-registry
 *
 * - Starts Verdaccio on http://localhost:4873
 * - Creates a local publish user and stores the auth token in tmp/verdaccio-token
 * - Kills Verdaccio on Ctrl+C / SIGTERM / SIGHUP
 *
 * Global npm/pnpm registry config is never modified — everything that talks to
 * the local registry passes --registry explicitly (see local-release.ts), so a
 * crash or hard kill cannot leave the developer's machine pointed at localhost.
 */

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect ChildProcess cannot hand Verdaccio one log descriptor shared by stdout and stderr.
import { openSync } from "node:fs";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}`;
const LOCAL_USER = "local-dev";
const LOCAL_PASS = "local-dev-password";

class LocalRegistryError extends Schema.TaggedError<LocalRegistryError>()("LocalRegistryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/* Only `AbortSignal.timeout`, so the deadline alone bounds the request and its unread response body. */
const abortAfter = (ms: number) =>
  Effect.updateService(FetchHttpClient.Fetch, (fetch) =>
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(ms) }),
      { preconnect: fetch.preconnect },
    ),
  );

const isPortInUse = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(`${REGISTRY}/-/ping`).pipe(
    abortAfter(1000),
    Effect.map((res) => res.status >= 200 && res.status < 300),
    Effect.orElseSucceed(() => false),
  );
});

const waitForRegistry = Effect.fnUntraced(function* (
  logPath: string,
  maxAttempts = 30,
  intervalMs = 500,
) {
  const client = yield* HttpClient.HttpClient;
  for (let i = 0; i < maxAttempts; i++) {
    const ready = yield* client.get(`${REGISTRY}/-/ping`).pipe(
      abortAfter(1000),
      Effect.map((res) => res.status >= 200 && res.status < 300),
      // not ready yet
      Effect.orElseSucceed(() => false),
    );
    if (ready) return;
    yield* Effect.sleep(intervalMs);
  }
  const totalSeconds = (maxAttempts * intervalMs) / 1000;
  return yield* new LocalRegistryError({
    message: `Verdaccio did not become ready within ${totalSeconds}s. Check logs: ${logPath}`,
  });
});

const foreignFailure = (cause: unknown) =>
  new LocalRegistryError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const tryAsync = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: foreignFailure });

/* Native `fetch` and `Response.json`, whose empty and null body handling `HttpClientResponse` cannot reproduce. */
const createUser = Effect.fnUntraced(function* () {
  const fetch = yield* FetchHttpClient.Fetch;
  const res = yield* tryAsync(() =>
    fetch(`${REGISTRY}/-/user/org.couchdb.user:${LOCAL_USER}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: LOCAL_USER,
        password: LOCAL_PASS,
        email: "local@local.dev",
        _id: `org.couchdb.user:${LOCAL_USER}`,
        type: "user",
        roles: [],
      }),
    }),
  );

  if (!res.ok) {
    const body = yield* tryAsync(() => res.text());
    return yield* new LocalRegistryError({
      message: `Failed to create Verdaccio user (HTTP ${res.status}): ${body}`,
    });
  }

  const body = (yield* tryAsync(() => res.json())) as { token?: string };
  if (!body.token) {
    return yield* new LocalRegistryError({
      message: "Verdaccio did not return an auth token after user creation.",
    });
  }
  return body.token;
});

const main = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = path.resolve(import.meta.dir, "../..");
  const tmpDir = path.join(root, "tmp", "verdaccio");
  const configPath = path.join(root, "tmp", "verdaccio.yaml");
  const tokenPath = path.join(root, "tmp", "verdaccio-token");
  const logPath = path.join(root, "tmp", "verdaccio.log");

  if (yield* isPortInUse()) {
    yield* Console.error(`\nError: Something is already running on port ${PORT}.`);
    yield* Console.error("If it's a leftover Verdaccio process, kill it first and retry.\n");
    process.exit(1);
  }

  // Fresh storage each run to avoid stale auth or package conflicts.
  yield* fs.remove(tmpDir, { recursive: true, force: true });
  yield* fs.makeDirectory(tmpDir, { recursive: true });

  const template = yield* tryAsync(() => Bun.file(path.join(root, "verdaccio.yaml")).text());
  const resolved = template.replaceAll("{root}", root);
  yield* fs.writeFileString(configPath, resolved);

  const logFd = yield* Effect.try({
    try: () => openSync(logPath, "w"),
    catch: foreignFailure,
  });
  const verdaccioBin = path.join(root, "node_modules", ".bin", "verdaccio");
  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn([verdaccioBin, "--config", configPath], {
        cwd: root,
        stdout: logFd,
        stderr: logFd,
      }),
    catch: foreignFailure,
  });

  // Handle unexpected Verdaccio crash.
  yield* Effect.forkChild(
    Effect.gen(function* () {
      const code = yield* Effect.promise(() => proc.exited);
      if (code !== 0 && code !== null) {
        yield* Console.error(
          `\nVerdaccio exited unexpectedly (code ${code}). Check logs: ${logPath}\n`,
        );
        process.exit(1);
      }
    }),
  );

  process.stdout.write(`Starting local registry at ${REGISTRY}...`);
  yield* waitForRegistry(logPath);
  process.stdout.write(" ready.\n");

  // Persisted so local-release.ts can read it.
  const token = yield* createUser();
  yield* fs.writeFileString(tokenPath, token);

  yield* Console.log(`
  Registry : ${REGISTRY}
  Token    : ${tokenPath}
  Logs     : ${logPath}

  Publish the CLI in another terminal:
    pnpm cli-release

  Global npm/pnpm registry config is untouched — pass --registry ${REGISTRY}
  to npx / npm install when testing the published package.

  Press Ctrl+C to stop.
`);

  const cleanup = () => {
    process.stdout.write("\nShutting down local registry...\n");
    proc.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Block until a signal is received.
  return yield* Effect.never;
});

await Effect.runPromise(
  main().pipe(
    /* Dies with the step's own cause, or a plain Error with its message, so the uncaught report has no `_tag` line. */
    Effect.catchTags({
      LocalRegistryError: (error) => Effect.die(error.cause ?? new Error(error.message)),
      PlatformError: (error) => Effect.die(error.cause ?? error),
    }),
    Effect.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        BunPath.layer,
        FetchHttpClient.layer,
        Layer.succeed(HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  ),
);
