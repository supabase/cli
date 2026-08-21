import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import { requireCliSuccess, runSupabase } from "../../../../tests/helpers/cli.ts";
import {
  legacySanitizeProjectId,
  legacyServiceContainerName,
  localDbContainerId,
} from "../../shared/legacy-docker-ids.ts";
import { legacyGetRegistryImageUrl } from "../../shared/legacy-docker-registry.ts";
import { LEGACY_SERVICE_CATALOG } from "../../shared/legacy-service-catalog.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;
const SHORT_LIVE_TIMEOUT_MS = 30_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;

/**
 * `--exclude` values for the 3 heaviest/least-relevant services — same intent
 * `stop.e2e.test.ts`/`status.e2e.test.ts` already documented for their own
 * reduced-stack `start` call (Studio's Next.js build, the Logflare/Vector
 * logging pipeline), but "logflare" here, NOT "analytics" like those two
 * siblings. `LEGACY_SERVICE_CATALOG`'s `excludeKey` for the logflare service
 * is "logflare" — "analytics" is only that service's *container suffix*
 * (`legacy-service-catalog.ts`), never a valid `--exclude` value. The
 * siblings' `--exclude analytics` is a silent no-op — harmless for their own
 * coarse "is the stack up/down" assertions, but this suite's exact-
 * container-set assertions need the genuinely valid key so logflare is
 * actually excluded.
 */
const EXCLUDED_SERVICE_KEYS: ReadonlySet<string> = new Set(["studio", "logflare", "vector"]);

/**
 * Services the running-container assertion below must NOT expect to be running, even though
 * they are neither in `EXCLUDED_SERVICE_KEYS` nor `--exclude`d on the `start` call itself:
 *  - `supavisor` — `db.pooler.enabled` defaults to `false` (`packages/config/src/db.ts`,
 *    `defaultPoolerEnabled`), and `runSupabase(["init"], ...)` above writes a config.toml
 *    with no override, so it's genuinely disabled on this test's stack, not merely unasserted.
 *  - `imgproxy` — gated on `storage.image_transformation.enabled` (`start.gates.ts:169`),
 *    which defaults to `false`/absent; `runSupabase(["init"], ...)` writes a config.toml
 *    with `[storage.image_transformation]` still commented out
 *    (`project-init.templates.ts:132-133`), so imgproxy is genuinely disabled on this test's stack.
 */
const NEVER_RUNNING_SERVICE_KEYS: ReadonlySet<string> = new Set(["supavisor", "imgproxy"]);

function splitNonEmptyLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// `start` is the one local-dev-stack command whose correctness genuinely
// depends on a real Docker daemon — real label filtering and real container
// lifecycle, not just CLI exit codes. `describe` gates the
// "we're in a configured e2e runner" signal (see stop.e2e.test.ts's own
// comment for why this, not a Management-API gate, is correct here). See
// AGENTS.md's "e2e tests" section for the full convention.
describe("supabase start (e2e)", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    // Best-effort cleanup even if an assertion above failed mid-lifecycle — a
    // leaked local stack would otherwise pollute the CI runner for later jobs.
    await runSupabase(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
  });

  test(
    "recreates a stopped real stack and preserves database data",
    { timeout: START_TIMEOUT_MS * 2 + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-start-live-"));
      // No `project_id` override, so the cli resolves it from the workdir
      // basename (see legacy-docker-ids.ts). Sanitizing is a no-op for a
      // `mkdtemp`-generated basename (already alphanumeric/`-`), but mirrors
      // the port's actual resolution rather than assuming that stays true.
      const projectId = legacySanitizeProjectId(path.basename(projectDir));
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

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      const start = await runSupabase(startArgs, {
        cwd: projectDir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      const persistedValue = "survived-stopped-container-recovery";
      await execFileAsync("docker", [
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

      const { stdout: containerIdOutput } = await execFileAsync("docker", [
        "ps",
        "--filter",
        projectFilter,
        "--format",
        "{{.ID}}",
      ]);
      const containerIds = splitNonEmptyLines(containerIdOutput);
      expect(containerIds.length).toBeGreaterThan(0);
      await execFileAsync("docker", ["stop", "--time", "0", ...containerIds], {
        timeout: SHORT_LIVE_TIMEOUT_MS,
      });

      const { stdout: stoppedState } = await execFileAsync("docker", [
        "container",
        "inspect",
        dbContainerId,
        "--format",
        "{{json .State}}",
      ]);
      expect(JSON.parse(stoppedState.trim())).toMatchObject({
        Running: false,
        Status: "exited",
      });

      const restart = await runSupabase(startArgs, {
        cwd: projectDir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      expect(restart.exitCode, `stdout:\n${restart.stdout}\nstderr:\n${restart.stderr}`).toBe(0);
      expect(restart.stderr).not.toContain("is already running");
      expect(restart.stderr).not.toContain("container is not running");

      const { stdout: persistedData } = await execFileAsync("docker", [
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

      // The real Docker daemon must agree with the CLI's own exit code: every
      // non-excluded service is actually running under this project's label,
      // AND every excluded service is genuinely absent — not merely reported
      // "stopped" by a status diff.
      const { stdout: psOutput } = await execFileAsync("docker", [
        "ps",
        "--filter",
        projectFilter,
        "--format",
        "{{.Names}}",
      ]);
      const runningNames = new Set(splitNonEmptyLines(psOutput));

      for (const entry of LEGACY_SERVICE_CATALOG) {
        const containerName = legacyServiceContainerName(entry.containerSuffix, projectId);
        const isExcluded =
          (entry.excludeKey !== undefined && EXCLUDED_SERVICE_KEYS.has(entry.excludeKey)) ||
          NEVER_RUNNING_SERVICE_KEYS.has(entry.service);
        expect(
          runningNames.has(containerName),
          `expected ${containerName} to be ${isExcluded ? "excluded" : "running"}; docker ps names: ${[...runningNames].join(", ")}`,
        ).toBe(!isExcluded);
      }

      const status = await runSupabase(["status"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      requireCliSuccess(status, "status setup");
    },
  );

  test(
    "bypasses an HTTPS proxy for loopback gateway health checks",
    { timeout: START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-start-live-proxy-"));

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      let proxyConnections = 0;
      const proxy = createServer((socket) => {
        proxyConnections += 1;
        socket.destroy();
      });

      try {
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const address = proxy.address();
        if (address === null || typeof address === "string") {
          throw new Error("Failed to allocate a proxy port");
        }

        const excludeArgs = LEGACY_SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined ||
          entry.excludeKey === "kong" ||
          entry.excludeKey === "postgrest"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const proxyUrl = `http://127.0.0.1:${address.port}`;
        const start = await runSupabase(["start", ...excludeArgs], {
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
      } finally {
        if (proxy.listening) {
          await new Promise<void>((resolve, reject) => {
            proxy.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        }
      }
    },
  );

  // The health watch inspects and dumps logs by container NAME against a real
  // daemon, and derives recovery advice from a real container's real log bytes.
  // Neither is observable through the in-process mocks, so this reproduces
  // supabase/cli#5952 for real: a locally cached image that cannot be executed.
  test(
    "names the container and its image when a cached image cannot be executed",
    { timeout: START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-start-live-exec-"));
      const projectId = legacySanitizeProjectId(path.basename(projectDir));
      const mailpitContainer = legacyServiceContainerName("inbucket", projectId);
      // The exact tag `start` resolves for Mailpit, so its already-cached check
      // finds this deliberately broken build and never reaches a registry.
      const mailpitImage = legacyGetRegistryImageUrl(dockerfileServiceImage("mailpit"));

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      // A `scratch` image whose entrypoint is not an executable binary — the
      // kernel refuses it with exactly the "exec format error" this diagnoses.
      const buildDir = path.join(projectDir, "broken-image");
      await mkdir(buildDir, { recursive: true });
      await writeFile(path.join(buildDir, "mailpit"), "not an executable\n", { mode: 0o755 });
      await writeFile(
        path.join(buildDir, "Dockerfile"),
        'FROM scratch\nCOPY mailpit /mailpit\nENTRYPOINT ["/mailpit"]\n',
      );
      await execFileAsync("docker", ["build", "-q", "-t", mailpitImage, buildDir]);

      try {
        // Everything except Postgres and Mailpit is excluded: this scenario only
        // needs one container that cannot start.
        const excludeArgs = LEGACY_SERVICE_CATALOG.flatMap((entry) =>
          entry.excludeKey === undefined || entry.excludeKey === "mailpit"
            ? []
            : ["--exclude", entry.excludeKey],
        );
        const start = await runSupabase(["start", ...excludeArgs], {
          cwd: projectDir,
          exitTimeoutMs: START_TIMEOUT_MS,
        });

        expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).not.toBe(0);
        // The container's established name is "inbucket", not the id `docker create` returns.
        expect(start.stderr).toContain(`${mailpitContainer} container logs:`);
        expect(start.stderr).toContain(`${mailpitContainer} container is not ready`);
        // ...and the advice names that container's actual resolved image.
        expect(start.stderr).toContain(`${mailpitContainer}'s image ${mailpitImage}`);
        expect(start.stderr).toContain(`image rm -f ${mailpitImage}`);
      } finally {
        // Never leave a poisoned tag behind for later jobs on this runner.
        await execFileAsync("docker", ["image", "rm", "-f", mailpitImage]).catch(() => undefined);
      }
    },
  );
});
