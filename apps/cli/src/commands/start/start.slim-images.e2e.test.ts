import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { BunServices } from "@effect/platform-bun";
import { Clock, Crypto, Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { catalogPins, type ArtifactKind } from "@supabase/stack/internal/artifacts";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { isSlimImageRef, toSlimImage } from "../../shared/services/slim-images.ts";
import {
  expectedPinnedImage,
  GHCR_SLIM_IMAGE_PATTERN,
} from "../../../tests/helpers/slim-images.ts";
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
const WGET_PROBE_TIMEOUT_MS = 10_000;
const WGET_PROBE_CLEANUP_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 240_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 120_000;

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
/**
 * Catalog services whose slim image ships BusyBox wget as its in-container probe (not the
 * Dockerfile-derived image: whether the Dockerfile's tag currently matches that catalog pin is
 * unrelated to whether the pinned slim image itself accepts the BusyBox argv).
 */
const WGET_PROBE_SERVICES: ReadonlyArray<ArtifactKind> = [
  "auth",
  "realtime",
  "storage",
  "analytics",
  "vector",
  "pooler",
];
const WGET_PROBE_TEST_TIMEOUT_MS =
  catalogPins()
    .filter((entry) => WGET_PROBE_SERVICES.includes(entry.service))
    .reduce((count, entry) => count + (entry.service === "vector" ? 2 : 1), 0) *
    (WGET_PROBE_TIMEOUT_MS + WGET_PROBE_CLEANUP_TIMEOUT_MS) +
  10_000;

function wgetProbeCatalogImages(): ReadonlyArray<string> {
  return catalogPins()
    .filter((entry) => WGET_PROBE_SERVICES.includes(entry.service))
    .map((entry) => entry.pin.image);
}

function latestImagesToPull(): ReadonlyArray<string> {
  const dockerfileImages = PULL_ALIASES.map((alias) => expectedSlimImage(alias));
  return [...new Set([...dockerfileImages, ...wgetProbeCatalogImages()])];
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

/** `kong` has no slim build at all, so this stays fallback-tolerant for the pull-ahead list. */
function expectedSlimImage(alias: string): string {
  const raw = dockerfileServiceImageRaw(alias);
  return toSlimImage(alias, raw) ?? raw;
}

/**
 * The Dockerfile aliases whose spec builder switches its healthcheck on `usesSlimImageRuntime`
 * (`*.service.ts`). Every one of them is slim today (`expectedPinnedImage`), but the assertions
 * below still derive the expected healthcheck from the image actually resolved, not from that
 * assumption directly.
 */
type HealthcheckedAlias = "gotrue" | "storage" | "realtime";

/** Mirrors each service's own upstream (non-slim) `healthcheck.test`, `CMD` prefix included. */
function upstreamHealthcheckTest(alias: HealthcheckedAlias): ReadonlyArray<string> {
  switch (alias) {
    case "gotrue":
      return [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:9999/health",
      ];
    case "storage":
      return [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:5000/status",
      ];
    case "realtime":
      return [
        "CMD",
        "curl",
        "-sSfL",
        "--head",
        "-o",
        "/dev/null",
        "-H",
        `Host:${REALTIME_TENANT_ID}`,
        "http://127.0.0.1:4000/api/ping",
      ];
  }
}

/** Mirrors each service's own slim (BusyBox wget) `healthcheck.test`, `CMD` prefix included. */
function slimHealthcheckTest(alias: HealthcheckedAlias): ReadonlyArray<string> {
  switch (alias) {
    case "gotrue":
      return slimWgetHealthcheck("http://127.0.0.1:9999/health").test;
    case "storage":
      return slimWgetHealthcheck("http://127.0.0.1:5000/status").test;
    case "realtime":
      return slimWgetHealthcheck("http://127.0.0.1:4000/api/ping", {
        header: `Host:${REALTIME_TENANT_ID}`,
      }).test;
  }
}

/** The `healthcheck.test` a container running `image` must have — matched to its family. */
function expectedHealthcheckTest(alias: HealthcheckedAlias, image: string): ReadonlyArray<string> {
  return isSlimImageRef(image) ? slimHealthcheckTest(alias) : upstreamHealthcheckTest(alias);
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

const runWgetInImage = Effect.fn("start.e2e.wgetProbe")(function* (
  image: string,
  args: ReadonlyArray<string>,
) {
  const crypto = yield* Crypto.Crypto;
  const containerName = `sb-wget-probe-${yield* crypto.randomUUIDv4}`;
  const removeContainer = runDockerEffect(["rm", "--force", containerName], {
    timeout: WGET_PROBE_CLEANUP_TIMEOUT_MS,
  }).pipe(
    Effect.catchTag("DockerCommandError", (error) => {
      const output = `${error.message}\n${error.stdout}\n${error.stderr}`;
      return /no such container/iu.test(output)
        ? Effect.void
        : Effect.fail(
            new StartE2eSetupError({
              message: `failed to clean up wget probe container ${containerName}: ${error.message}`,
              cause: error,
            }),
          );
    }),
  );
  return yield* runDockerEffect(
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "none",
      "--entrypoint",
      "wget",
      image,
      ...args,
    ],
    { timeout: WGET_PROBE_TIMEOUT_MS },
  ).pipe(
    Effect.catchTag("DockerCommandError", (error) => {
      const output = `${error.stdout}\n${error.stderr}`;
      return /^wget: can't connect to remote host \(127\.0\.0\.1\): Connection refused\r?$/mu.test(
        output,
      )
        ? Effect.succeed({ stdout: error.stdout, stderr: error.stderr })
        : Effect.fail(
            new StartE2eSetupError({
              message: `wget probe failed for ${image}: ${error.message}`,
              cause: error,
            }),
          );
    }),
    Effect.onExit(() => removeContainer),
  );
});

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
    "every pinned slim wget image accepts the BusyBox healthcheck argv",
    () =>
      Effect.gen(function* () {
        for (const entry of catalogPins()) {
          if (!WGET_PROBE_SERVICES.includes(entry.service)) continue;
          const image = entry.pin.image;
          const probe =
            entry.service === "realtime"
              ? slimWgetHealthcheck("http://127.0.0.1:9/", {
                  header: `Host:${REALTIME_TENANT_ID}`,
                })
              : slimWgetHealthcheck("http://127.0.0.1:9/");
          expectBusyBoxAccepted(yield* runWgetInImage(image, probe.test.slice(2)), image);
          if (entry.service === "vector") {
            const waitArgs = slimWgetWaitCommand("http://127.0.0.1:9/").split(" ").slice(1);
            expectBusyBoxAccepted(yield* runWgetInImage(image, waitArgs), `${image} wait`);
          }
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
    WGET_PROBE_TEST_TIMEOUT_MS,
  );

  it.live(
    "starts each service on its resolved image (slim or upstream), matching healthchecks to family, and serves a function without a version pin",
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
        // The template imports from live jsr/npm; new.stack.e2e.test.ts covers that resolution.
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "functions", "hello", "index.ts"),
          'Deno.serve(async (req) => Response.json({ message: "Hello " + (await req.json()).name + "!" }));\n',
        );
        yield* overridePorts(projectDir);
        const config = yield* fs.readFileString(path.join(projectDir, "supabase", "config.toml"));
        const apiPort = readSectionPort(config, "api");

        const start = yield* runSupabaseEffect(START_ARGS, {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
          env: SLIM_ENV,
        });
        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

        // Every alias here is slim-capable, and its default Dockerfile tag is generated from the
        // catalog, so it matches a catalog pin — so each expected image is read straight from the catalog
        // (`expectedPinnedImage`), independent of `toSlimImage`.
        const authImage = expectedPinnedImage("gotrue", dockerfileServiceImageRaw("gotrue"));
        const realtimeImage = expectedPinnedImage(
          "realtime",
          dockerfileServiceImageRaw("realtime"),
        );
        const storageImage = expectedPinnedImage("storage", dockerfileServiceImageRaw("storage"));
        for (const image of [authImage, realtimeImage, storageImage]) {
          expect(image).toMatch(GHCR_SLIM_IMAGE_PATTERN);
        }

        expect(yield* containerImage(dbContainer)).toBe(
          expectedPinnedImage("pg", dockerfileServiceImageRaw("pg")),
        );
        expect(yield* containerImage(storageContainer)).toBe(storageImage);
        expect(yield* containerImage(edgeRuntimeContainer)).toBe(
          expectedPinnedImage("edgeruntime", dockerfileServiceImageRaw("edgeruntime")),
        );
        expect(yield* containerImage(authContainer)).toBe(authImage);
        expect(yield* containerImage(realtimeContainer)).toBe(realtimeImage);

        expect(yield* containerHealthcheckTest(authContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(expectedHealthcheckTest("gotrue", authImage)),
        ]);
        expect(yield* containerHealthcheckTest(realtimeContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(expectedHealthcheckTest("realtime", realtimeImage)),
        ]);
        expect(yield* containerHealthcheckTest(storageContainer)).toEqual([
          "CMD-SHELL",
          buildHealthCmdArg(expectedHealthcheckTest("storage", storageImage)),
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
          throw new Error(
            `Functions request failed (${invoked.status}): ${body}\n${yield* edgeRuntimeFailureDiagnostics(edgeRuntimeContainer)}`,
          );
        }
        expect(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).toEqual({
          message: "Hello Functions!",
        });
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer))),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS + CLEANUP_TIMEOUT_MS,
  );
});
