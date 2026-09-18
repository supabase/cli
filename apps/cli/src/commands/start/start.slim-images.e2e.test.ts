import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { BunServices } from "@effect/platform-bun";
import { Clock, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { beforeAll, describe, expect, it } from "@effect/vitest";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../shared/services/slim-images.ts";
import { buildHealthCmdArg } from "../../command-internal/db-bootstrap/docker-create-args.ts";
import {
  slimWgetHealthcheck,
  slimWgetWaitCommand,
} from "../../command-internal/db-bootstrap/slim-runtime.ts";
import { REALTIME_TENANT_ID } from "../../command-internal/db-bootstrap/realtime-env.ts";
import { ensureImage } from "../../../tests/helpers/docker-image.ts";
import {
  overrideStackPorts,
  requireCliSuccess,
  runSupabaseEffect,
  runDockerEffect,
} from "../../../tests/helpers/cli.ts";
import {
  sanitizeProjectId,
  serviceContainerName,
  localDbContainerId,
} from "../../command-internal/docker-ids.ts";

class StartE2eSetupError extends Data.TaggedError("StartE2eSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const overridePorts = (dir: string) =>
  Effect.tryPromise({
    try: () => overrideStackPorts(dir),
    catch: (cause) => new StartE2eSetupError({ message: "failed to override stack ports", cause }),
  });
const makeProject = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* Effect.addFinalizer(() =>
    runSupabaseEffect(["stop", "--no-backup"], { cwd: dir, env: SLIM_ENV }).pipe(Effect.ignore),
  );
  return dir;
});

const START_TIMEOUT_MS = 280_000;
const SHORT_E2E_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 240_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;

const SLIM_ENV = { SUPABASE_USE_SLIM_IMAGES: "1" } as const;
/** Override an inherited dogfood/CI flag so docker.io starts stay on docker.io. */
const DOCKER_IO_ENV = { SUPABASE_USE_SLIM_IMAGES: "" } as const;
const START_ARGS = ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"];
const PULL_ALIASES = [
  "pg",
  "gotrue",
  "postgrest",
  "realtime",
  "storage",
  "edgeruntime",
  "pgmeta",
  "mailpit",
  "kong",
] as const;
/** Slim images whose in-container probe is BusyBox wget. */
const WGET_PROBE_ALIASES = [
  "gotrue",
  "realtime",
  "storage",
  "logflare",
  "supavisor",
  "vector",
] as const;

function latestImagesToPull(): ReadonlyArray<string> {
  return [...new Set([...PULL_ALIASES, ...WGET_PROBE_ALIASES])].map((alias) =>
    toSlimImage(alias, dockerfileServiceImageRaw(alias)),
  );
}

function readSectionPort(config: string, section: string): number {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\[${escaped}\\][\\s\\S]*?^port = (\\d+)`, "m").exec(config);
  if (match?.[1] === undefined) {
    throw new Error(`missing [${section}] port`);
  }
  return Number(match[1]);
}
const containerImage = Effect.fnUntraced(function* (name: string) {
  const { stdout } = yield* runDockerEffect(["inspect", name, "--format", "{{.Config.Image}}"]);
  return stdout.trim();
});

function expectedSlimImage(alias: string): string {
  return toSlimImage(alias, dockerfileServiceImageRaw(alias));
}

const containerHealthcheckTest = Effect.fnUntraced(function* (name: string) {
  const { stdout } = yield* runDockerEffect([
    "inspect",
    name,
    "--format",
    "{{json .Config.Healthcheck.Test}}",
  ]);
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    stdout.trim(),
  );
});

const containerHealthStatus = Effect.fnUntraced(function* (name: string) {
  const { stdout } = yield* runDockerEffect([
    "inspect",
    name,
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
  ]);
  return stdout.trim();
});

const edgeRuntimeFailureDiagnostics = Effect.fnUntraced(function* (name: string) {
  const mounts = yield* runDockerEffect(["inspect", name, "--format", "{{json .Mounts}}"]).pipe(
    Effect.map(({ stdout }) => stdout.trim() || "[]"),
    Effect.catch((error) => Effect.succeed(`<unavailable: ${error.message}>`)),
  );
  const logs = yield* runDockerEffect(["logs", name]).pipe(
    Effect.map(({ stdout, stderr }) => `${stdout}${stderr}`.trim() || "<empty>"),
    Effect.catch((error) => Effect.succeed(`<unavailable: ${error.message}>`)),
  );
  return `edge runtime Mounts: ${mounts}\nedge runtime logs:\n${logs}`;
});

const runWgetInImage = (image: string, args: ReadonlyArray<string>) =>
  runDockerEffect([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "wget",
    image,
    ...args,
  ]).pipe(
    Effect.catchTag("DockerCommandError", (error) =>
      Effect.succeed({ stdout: error.stdout, stderr: error.stderr }),
    ),
  );

function expectBusyBoxAccepted(
  output: { readonly stdout: string; readonly stderr: string },
  label: string,
): void {
  const text = `${output.stdout}\n${output.stderr}`;
  expect(text, label).not.toMatch(
    /Unable to find image|executable file not found|unrecognized option|invalid option|unknown option/i,
  );
}

const pullLatestImage = Effect.fnUntraced(function* (image: string, deadline: number) {
  const now = yield* Clock.currentTimeMillis;
  yield* runDockerEffect(["pull", image], { timeout: Math.max(1, deadline - now) }).pipe(
    Effect.catch(() =>
      Effect.tryPromise({
        try: () => ensureImage(image, deadline),
        catch: (cause) =>
          new StartE2eSetupError({ message: "failed to ensure Docker image", cause }),
      }),
    ),
  );
});

describe("supabase start slim images (e2e)", () => {
  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + PULL_TIMEOUT_MS;
          for (const image of latestImagesToPull()) {
            yield* pullLatestImage(image, deadline);
          }
        }).pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
      ),
    PULL_TIMEOUT_MS + 10_000,
  );

  it.live(
    "every slim wget image accepts the BusyBox healthcheck argv",
    () =>
      Effect.gen(function* () {
        for (const alias of WGET_PROBE_ALIASES) {
          const image = expectedSlimImage(alias);
          const probe =
            alias === "realtime"
              ? slimWgetHealthcheck("http://127.0.0.1:9/", {
                  header: `Host:${REALTIME_TENANT_ID}`,
                })
              : slimWgetHealthcheck("http://127.0.0.1:9/");
          expectBusyBoxAccepted(yield* runWgetInImage(image, probe.test.slice(2)), image);
          if (alias === "vector") {
            const waitArgs = slimWgetWaitCommand("http://127.0.0.1:9/").split(" ").slice(1);
            expectBusyBoxAccepted(yield* runWgetInImage(image, waitArgs), `${image} wait`);
          }
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
    SHORT_E2E_TIMEOUT_MS,
  );

  it.live(
    "starts the latest slim images, serves a function without a version pin, and keeps the Dockerfile tag",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-slim-start-e2e-");
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const projectId = sanitizeProjectId(path.basename(projectDir));
        const edgeRuntimeContainer = serviceContainerName("edge_runtime", projectId);
        const dbContainer = localDbContainerId(projectId);
        const storageContainer = serviceContainerName("storage", projectId);
        const authContainer = serviceContainerName("auth", projectId);
        const realtimeContainer = serviceContainerName("realtime", projectId);

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
          env: DOCKER_IO_ENV,
        });
        requireCliSuccess(init, "init");

        const created = yield* runSupabaseEffect(["functions", "new", "hello", "--auth", "none"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
          env: { ...DOCKER_IO_ENV, SUPABASE_YES: "1" },
        });
        requireCliSuccess(created, "functions new");
        yield* overridePorts(projectDir);
        const config = yield* fs.readFileString(path.join(projectDir, "supabase", "config.toml"));
        const apiPort = readSectionPort(config, "api");

        const start = yield* runSupabaseEffect(START_ARGS, {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
          env: SLIM_ENV,
        });
        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

        expect(yield* containerImage(dbContainer)).toBe(expectedSlimImage("pg"));
        expect(yield* containerImage(storageContainer)).toBe(expectedSlimImage("storage"));
        expect(yield* containerImage(edgeRuntimeContainer)).toBe(expectedSlimImage("edgeruntime"));

        expect(yield* containerHealthcheckTest(authContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(slimWgetHealthcheck("http://127.0.0.1:9999/health").test),
        ]);
        expect(yield* containerHealthcheckTest(realtimeContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(
            slimWgetHealthcheck("http://127.0.0.1:4000/api/ping", {
              header: `Host:${REALTIME_TENANT_ID}`,
            }).test,
          ),
        ]);
        expect(yield* containerHealthcheckTest(storageContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(slimWgetHealthcheck("http://127.0.0.1:5000/status").test),
        ]);
        expect(yield* containerHealthStatus(authContainer)).toBe("healthy");
        expect(yield* containerHealthStatus(realtimeContainer)).toBe("healthy");
        expect(yield* containerHealthStatus(storageContainer)).toBe("healthy");

        const invoked = yield* HttpClientRequest.post(
          `http://127.0.0.1:${apiPort}/functions/v1/hello`,
        ).pipe(
          HttpClientRequest.bodyText('{"name":"Functions"}', "application/json"),
          HttpClient.execute,
        );
        const body = yield* invoked.text;
        if (invoked.status < 200 || invoked.status >= 300) {
          return yield* new StartE2eSetupError({
            message: `Functions request failed (${invoked.status}): ${body}\n${yield* edgeRuntimeFailureDiagnostics(edgeRuntimeContainer)}`,
          });
        }
        expect(
          yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
          )(body),
        ).toEqual({ message: "Hello Functions!" });
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS,
  );
});
