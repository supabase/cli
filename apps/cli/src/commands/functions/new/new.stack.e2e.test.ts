// Golden path for a stack-mode project: `functions new hello` scaffolds the template, `stack
// start` boots it, and a real request proves Edge Runtime resolves the template's import map.
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { homedir } from "node:os";

import { makeTempHome, runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const NEW_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
// The template's first request resolves `jsr:@supabase/functions-js` and `npm:@supabase/server`
// over the network, on top of waking the lazily-started Functions member.
const INVOKE_TIMEOUT_MS = 5 * 60_000;
const SETUP_MARGIN_MS = 60_000;

const minimalConfig = `project_id = "functions-new-stack-e2e"

[experimental]
stack = true

[api]
enabled = true

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = true

[realtime]
enabled = false

[storage]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[local_smtp]
enabled = false
`;

const StartResultSchema = Schema.Struct({ id: Schema.String });
const StackEnvSchema = Schema.Struct({ API_URL: Schema.String, PUBLISHABLE_KEY: Schema.String });
const HelloResponseSchema = Schema.Struct({ message: Schema.String });

const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("functions new (stack e2e)", () => {
  for (const runtime of ["native", "docker"] as const) {
    if (runtime === "native" && !nativeSupported) continue;

    it.live(
      `serves the generated hello Function through ${runtime} stack start`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // Linux Edge Runtime overlays /tmp with a private worker filesystem, so native functions need a visible host path.
          const projectDir = yield* fs.makeTempDirectoryScoped({
            ...(runtime === "native" && process.platform === "linux"
              ? { directory: homedir() }
              : {}),
            prefix: `functions-new-stack-${runtime}-`,
          });
          const home = makeTempHome();
          yield* Effect.addFinalizer(() => Effect.sync(() => home[Symbol.dispose]()));
          yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(projectDir, "supabase", "config.toml"),
            minimalConfig,
          );

          const created = yield* runSupabaseEffect(
            ["functions", "new", "hello", "--output-format", "json"],
            { cwd: projectDir, home: home.dir, exitTimeoutMs: NEW_TIMEOUT_MS },
          );
          expect(created.exitCode, `stdout:\n${created.stdout}\nstderr:\n${created.stderr}`).toBe(
            0,
          );

          let stackId: string | undefined;
          yield* Effect.addFinalizer(() =>
            stackId === undefined
              ? Effect.void
              : runSupabaseEffect(["stack", "destroy", "--stack-id", stackId, "--yes"], {
                  cwd: projectDir,
                  home: home.dir,
                  env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
                  exitTimeoutMs: CLEANUP_TIMEOUT_MS,
                }).pipe(
                  Effect.orDie,
                  Effect.flatMap((destroyed) =>
                    destroyed.exitCode === 0
                      ? Effect.void
                      : Effect.die(
                          `stack destroy exited ${destroyed.exitCode}\nstdout:\n${destroyed.stdout}\nstderr:\n${destroyed.stderr}`,
                        ),
                  ),
                ),
          );

          const started = yield* runSupabaseEffect(
            ["stack", "start", "--runtime", runtime, "--output-format", "json"],
            {
              cwd: projectDir,
              home: home.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: START_TIMEOUT_MS,
            },
          );
          expect(started.exitCode, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(
            0,
          );
          const startResult = yield* Schema.decodeEffect(Schema.fromJsonString(StartResultSchema))(
            started.stdout.trim(),
          );
          stackId = startResult.id;

          const status = yield* runSupabaseEffect(
            ["stack", "status", "--env", "--stack-id", stackId, "--output-format", "json"],
            {
              cwd: projectDir,
              home: home.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs: CLEANUP_TIMEOUT_MS,
            },
          );
          expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
          const env = yield* Schema.decodeEffect(Schema.fromJsonString(StackEnvSchema))(
            status.stdout,
          );

          const http = yield* HttpClient.HttpClient;
          const request = yield* HttpClientRequest.post(`${env.API_URL}/functions/v1/hello`, {
            headers: { apikey: env.PUBLISHABLE_KEY },
          }).pipe(HttpClientRequest.bodyJson({ name: "e2e" }));
          const response = yield* http.execute(request).pipe(Effect.timeout(INVOKE_TIMEOUT_MS));
          const text = yield* response.text;
          expect(response.status, `response body:\n${text}`).toBe(200);
          const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(HelloResponseSchema))(
            text,
          );
          expect(decoded).toEqual({ message: "Hello e2e!" });
        }).pipe(Effect.provide(layer)),
      {
        timeout:
          NEW_TIMEOUT_MS +
          START_TIMEOUT_MS +
          CLEANUP_TIMEOUT_MS +
          INVOKE_TIMEOUT_MS +
          CLEANUP_TIMEOUT_MS +
          SETUP_MARGIN_MS,
      },
    );
  }
});
