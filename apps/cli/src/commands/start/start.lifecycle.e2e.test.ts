import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { createServer } from "node:net";
import { describe, expect, it } from "@effect/vitest";

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
import { getRegistryImageUrl } from "../../command-internal/docker-registry.ts";
import { SERVICE_CATALOG } from "../../command-internal/service-catalog.ts";
import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";

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
    runSupabaseEffect(["stop", "--no-backup"], { cwd: dir }).pipe(Effect.ignore),
  );
  return dir;
});

const START_TIMEOUT_MS = 280_000;
const SHORT_E2E_TIMEOUT_MS = 30_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;

/**
 * `--exclude` values for the 3 heaviest, least-relevant services (same set the sibling Docker
 * e2e suites use): Studio's Next.js build and the Logflare/Vector logging pipeline. The service
 * catalog's exclusion key for the logging service is `logflare`.
 */
const EXCLUDED_SERVICE_KEYS: ReadonlySet<string> = new Set(["studio", "logflare", "vector"]);

/**
 * Services the running-container assertion below must not expect to be running, even though
 * they are neither in `EXCLUDED_SERVICE_KEYS` nor `--exclude`d on the `start` call itself:
 *  - `supavisor` — `db.pooler.enabled` defaults to `false`, and this test's `init`-written
 *    config.toml has no override, so it's genuinely disabled, not merely unasserted.
 *  - `imgproxy` — gated on `storage.image_transformation.enabled`, which the same config.toml
 *    leaves commented out (defaulting to disabled).
 */
const NEVER_RUNNING_SERVICE_KEYS: ReadonlySet<string> = new Set(["supavisor", "imgproxy"]);

function splitNonEmptyLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// `start`'s correctness genuinely depends on a real Docker daemon — real label filtering and
// container lifecycle, not just CLI exit codes. See `stop.e2e.test.ts` and AGENTS.md's "e2e
// tests" section for the runner-gating convention.
describe("supabase start (e2e)", () => {
  it.live(
    "recreates a stopped real stack and preserves database data",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-start-e2e-");
        const path = yield* Path.Path;
        // No `project_id` override, so the CLI resolves it from the workdir basename. Sanitizing
        // is currently a no-op for a `mkdtemp` basename, but mirrors the CLI's actual resolution.
        const projectId = sanitizeProjectId(path.basename(projectDir));
        const projectFilter = `label=com.supabase.cli.project=${projectId}`;
        const dbContainerId = localDbContainerId(projectId);
        const startArgs = [
          "start",
          "--exclude",
          "studio",
          "--exclude",
          "logflare",
          "--exclude",
          "vector",
        ];

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(init, "init setup");
        yield* overridePorts(projectDir);

        const start = yield* runSupabaseEffect(startArgs, {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });
        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

        const persistedValue = "survived-stopped-container-recovery";
        yield* runDockerEffect([
          "exec",
          dbContainerId,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `CREATE TABLE start_restart_regression (value text NOT NULL); INSERT INTO start_restart_regression VALUES ('${persistedValue}');`,
        ]);

        const { stdout: containerIdOutput } = yield* runDockerEffect([
          "ps",
          "--filter",
          projectFilter,
          "--format",
          "{{.ID}}",
        ]);
        const containerIds = splitNonEmptyLines(containerIdOutput);
        expect(containerIds.length).toBeGreaterThan(0);
        yield* runDockerEffect(["stop", "--time", "0", ...containerIds], {
          timeout: SHORT_E2E_TIMEOUT_MS,
        });

        const { stdout: stoppedState } = yield* runDockerEffect([
          "container",
          "inspect",
          dbContainerId,
          "--format",
          "{{json .State}}",
        ]);
        expect(
          yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ Running: Schema.Boolean, Status: Schema.String }),
            ),
          )(stoppedState.trim()),
        ).toMatchObject({
          Running: false,
          Status: "exited",
        });

        const restart = yield* runSupabaseEffect(startArgs, {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });
        expect(restart.exitCode, `stdout:\n${restart.stdout}\nstderr:\n${restart.stderr}`).toBe(0);
        expect(restart.stderr).not.toContain("is already running");
        expect(restart.stderr).not.toContain("container is not running");

        const { stdout: persistedData } = yield* runDockerEffect([
          "exec",
          dbContainerId,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-Atc",
          "SELECT value FROM start_restart_regression;",
        ]);
        expect(persistedData.trim()).toBe(persistedValue);

        const { stdout: psOutput } = yield* runDockerEffect([
          "ps",
          "--filter",
          projectFilter,
          "--format",
          "{{.Names}}",
        ]);
        const runningNames = new Set(splitNonEmptyLines(psOutput));

        for (const entry of SERVICE_CATALOG) {
          const containerName = serviceContainerName(entry.containerSuffix, projectId);
          const isExcluded =
            (entry.excludeKey !== undefined && EXCLUDED_SERVICE_KEYS.has(entry.excludeKey)) ||
            NEVER_RUNNING_SERVICE_KEYS.has(entry.service);
          expect(
            runningNames.has(containerName),
            `expected ${containerName} to be ${isExcluded ? "excluded" : "running"}; docker ps names: ${[...runningNames].join(", ")}`,
          ).toBe(!isExcluded);
        }

        const status = yield* runSupabaseEffect(["status"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(status, "status setup");
      }).pipe(Effect.provide(BunServices.layer)),
    START_TIMEOUT_MS * 2 + LIFECYCLE_OVERHEAD_MS,
  );

  it.live(
    "bypasses an HTTPS proxy for loopback gateway health checks",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-start-e2e-proxy-");

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(init, "init setup");

        let proxyConnections = 0;
        const proxy = yield* Effect.acquireRelease(
          Effect.callback<ReturnType<typeof createServer>, StartE2eSetupError>((resume) => {
            const server = createServer((socket) => {
              proxyConnections += 1;
              socket.destroy();
            });
            const onError = (cause: Error) =>
              resume(Effect.fail(new StartE2eSetupError({ message: cause.message, cause })));
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
              server.removeListener("error", onError);
              resume(Effect.succeed(server));
            });
            return Effect.sync(() => {
              server.removeListener("error", onError);
              server.close();
            });
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            }),
        );
        const address = proxy.address();
        if (address === null || typeof address === "string") {
          throw new Error("Failed to allocate a proxy port");
        }
        yield* overridePorts(projectDir);

        const excludeArgs = SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined ||
          entry.excludeKey === "kong" ||
          entry.excludeKey === "postgrest"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const proxyUrl = `http://127.0.0.1:${address.port}`;
        const start = yield* runSupabaseEffect(["start", ...excludeArgs], {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
          env: {
            HTTP_PROXY: "",
            http_proxy: "",
            HTTPS_PROXY: proxyUrl,
            https_proxy: proxyUrl,
            NO_PROXY: "",
            no_proxy: "",
            SUPABASE_API_TLS_ENABLED: "true",
            SUPABASE_SERVICES_HOSTNAME: "127.0.0.1",
          },
        });

        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);
        expect(start.stdout).toContain("https://127.0.0.1:");
        expect(proxyConnections).toBe(0);
      }).pipe(Effect.provide(BunServices.layer)),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS,
  );

  // The health watch inspects and dumps logs by container name against a real daemon and derives
  // recovery advice from real log bytes — not observable through in-process mocks. Reproduces
  // supabase/cli#5952: a locally cached image that cannot be executed.
  it.live(
    "names the container and its image when a cached image cannot be executed",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProject("sb-start-e2e-exec-");
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const projectId = sanitizeProjectId(path.basename(projectDir));
        const mailpitContainer = serviceContainerName("inbucket", projectId);
        // The exact tag `start` resolves for Mailpit, so its already-cached check finds this
        // broken build without reaching a registry.
        const mailpitImage = yield* getRegistryImageUrl(dockerfileServiceImage("mailpit"));

        const init = yield* runSupabaseEffect(["init"], {
          cwd: projectDir,
          exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        });
        requireCliSuccess(init, "init setup");
        yield* overridePorts(projectDir);

        // A `scratch` image whose entrypoint is not an executable binary — the
        // kernel refuses it with exactly the "exec format error" this diagnoses.
        const buildDir = path.join(projectDir, "broken-image");
        yield* fs.makeDirectory(buildDir, { recursive: true });
        yield* fs.writeFileString(path.join(buildDir, "mailpit"), "not an executable\n", {
          mode: 0o755,
        });
        yield* fs.writeFileString(
          path.join(buildDir, "Dockerfile"),
          'FROM scratch\nCOPY mailpit /mailpit\nENTRYPOINT ["/mailpit"]\n',
        );
        yield* runDockerEffect(["build", "-q", "-t", mailpitImage, buildDir]);

        yield* Effect.addFinalizer(() =>
          runDockerEffect(["image", "rm", "-f", mailpitImage]).pipe(Effect.ignore),
        );

        // Everything except Postgres and Mailpit is excluded: this scenario only
        // needs one container that cannot start.
        const excludeArgs = SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined || entry.excludeKey === "mailpit"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const start = yield* runSupabaseEffect(["start", ...excludeArgs], {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });

        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).not.toBe(0);
        // The container's established name is "inbucket", not the id `docker create` returns.
        expect(start.stderr).toContain(`${mailpitContainer} container logs:`);
        expect(start.stderr).toContain(`${mailpitContainer} container is not ready`);
        expect(start.stderr).toContain(`${mailpitContainer}'s image ${mailpitImage}`);
        expect(start.stderr).toContain(`image rm -f ${mailpitImage}`);
      }).pipe(Effect.provide(BunServices.layer)),
    START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS,
  );
});
