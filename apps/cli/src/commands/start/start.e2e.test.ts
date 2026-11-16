import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  createTempHome,
  requireCliSuccess,
  runSupabaseEffect,
  stripAnsi,
  withTempCliProject,
} from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 4 * 60_000;
const CLEANUP_TIMEOUT_MS = 60_000;

const projectConfig = (siteUrl: string) => `project_id = "start-config-restart-e2e"

[experimental]
stack = true

[auth]
site_url = "${siteUrl}"

[db.pooler]
enabled = false

[edge_runtime]
enabled = false

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

class StartConfigRestartE2eError extends Data.TaggedError("StartConfigRestartE2eError")<{
  readonly message: string;
}> {}

const StartedEnv = Schema.fromJsonString(
  Schema.Struct({ env: Schema.Struct({ API_URL: Schema.String, SECRET_KEY: Schema.String }) }),
);
const GeneratedLink = Schema.fromJsonString(Schema.Struct({ redirect_to: Schema.String }));

describe("supabase start", () => {
  // An unreachable `DOCKER_HOST` forces a fast, deterministic failure regardless of whether a
  // real Docker daemon is reachable in the sandbox.
  it.live(
    "prints the invalid --exclude warning then fails cleanly on the Docker call",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-start-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["start", "--exclude", "bogus"],
          {
            cwd: projectDir,
            env: { DOCKER_HOST: "tcp://127.0.0.1:1" },
          },
        );

        expect(stripAnsi(stderr), `stdout:\n${stdout}\nstderr:\n${stderr}`).toContain(
          "WARNING: The following container names are not valid to exclude: bogus",
        );
        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).not.toBe(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "applies an edited auth.site_url after stop and start",
    () =>
      withTempCliProject("start-config-restart-", (project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const http = yield* HttpClient.HttpClient;
          /* Left to the e2e cleanup drain, which disposes it with the stack project it serves. */
          const home = yield* createTempHome;
          const configPath = path.join(project.dir, "supabase", "config.toml");
          yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
          yield* fs.writeFileString(configPath, projectConfig("http://127.0.0.1:3001"));
          /* Clears an ambient backend switch so `[experimental] stack` in the project routes `start`. */
          const cli = (args: Array<string>, exitTimeoutMs = CLEANUP_TIMEOUT_MS) =>
            runSupabaseEffect(args, {
              cwd: project.dir,
              home: home.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: undefined },
              exitTimeoutMs,
            });
          yield* Effect.addFinalizer(() =>
            cli(["stack", "destroy", "--yes"]).pipe(
              Effect.flatMap((destroyed) =>
                destroyed.exitCode === 0
                  ? Effect.void
                  : new StartConfigRestartE2eError({
                      message: `stack destroy exited ${destroyed.exitCode}: ${destroyed.stderr}`,
                    }),
              ),
              Effect.orDie,
            ),
          );

          /* The default redirect of an admin magic link is the running Auth's site URL. */
          const startedSiteUrl = (email: string) =>
            Effect.gen(function* () {
              const started = yield* cli(
                ["start", "--runtime", "docker", "--output-format", "json"],
                COMMAND_TIMEOUT_MS,
              );
              requireCliSuccess(started, "start");
              const { env } = yield* Schema.decodeEffect(StartedEnv)(started.stdout.trim());
              const link = yield* http.execute(
                HttpClientRequest.post(`${env.API_URL}/auth/v1/admin/generate_link`).pipe(
                  HttpClientRequest.setHeaders({
                    apikey: env.SECRET_KEY,
                    authorization: `Bearer ${env.SECRET_KEY}`,
                  }),
                  HttpClientRequest.bodyJsonUnsafe({ type: "magiclink", email }),
                ),
              );
              const body = yield* link.text;
              expect(link.status, body).toBe(200);
              return (yield* Schema.decodeEffect(GeneratedLink)(body)).redirect_to;
            });

          expect(yield* startedSiteUrl("before@example.com")).toBe("http://127.0.0.1:3001");
          yield* fs.writeFileString(configPath, projectConfig("http://127.0.0.1:4321"));
          requireCliSuccess(yield* cli(["stop"]), "stop");
          expect(yield* startedSiteUrl("after@example.com")).toBe("http://127.0.0.1:4321");
        }).pipe(Effect.scoped),
      ).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
    2 * COMMAND_TIMEOUT_MS + 2 * CLEANUP_TIMEOUT_MS,
  );
});
