import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../tests/helpers/live.ts";
import {
  legacySanitizeProjectId,
  legacyServiceContainerName,
} from "../../shared/legacy-docker-ids.ts";
import { LEGACY_SERVICE_CATALOG } from "../../shared/legacy-service-catalog.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;
const SHORT_LIVE_TIMEOUT_MS = 30_000;

/**
 * `--exclude` values for the 3 heaviest/least-relevant services — same intent
 * `stop.live.test.ts`/`status.live.test.ts` already documented for their own
 * reduced-stack `start` call (Studio's Next.js build, the Logflare/Vector
 * logging pipeline), but "logflare" here, NOT "analytics" like those two
 * siblings. `LEGACY_SERVICE_CATALOG`'s `excludeKey` for the logflare service
 * (Go's `utils.ShortContainerImageName` applied to the logflare image,
 * `apps/cli-go/internal/utils/misc.go:33-39`) is "logflare" — "analytics" is
 * only that service's *container suffix* (`legacy-service-catalog.ts`), never
 * a valid `--exclude` value in either Go or this port. The siblings'
 * `--exclude analytics` was a silent no-op passed straight through to `start`
 * while it was still a Go-binary proxy — harmless for their own coarse "is
 * the stack up/down" assertions, but this suite's exact-container-set
 * assertions need the genuinely valid key so logflare is actually excluded.
 */
const EXCLUDED_SERVICE_KEYS: ReadonlySet<string> = new Set(["studio", "logflare", "vector"]);

/**
 * Services the running-container assertion below must NOT expect to be running, even though
 * they are neither in `EXCLUDED_SERVICE_KEYS` nor `--exclude`d on the `start` call itself:
 *  - `supavisor` — `db.pooler.enabled` defaults to `false` (`packages/config/src/db.ts`,
 *    `defaultPoolerEnabled`), and `runSupabaseLive(["init"], ...)` above writes a config.toml
 *    with no override, so it's genuinely disabled on this test's stack, not merely unasserted.
 *  - `imgproxy` — gated on `storage.image_transformation.enabled` (`start.gates.ts:169`,
 *    mirroring Go's `isImgProxyEnabled`, `apps/cli-go/internal/start/start.go:302-303`), which
 *    defaults to `false`/absent; `runSupabaseLive(["init"], ...)` writes a config.toml with
 *    `[storage.image_transformation]` still commented out (`project-init.templates.ts:132-133`,
 *    byte-identical to Go's own template), so imgproxy is genuinely disabled on this test's stack.
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
// lifecycle, not just CLI exit codes. `describeLive` is reused purely as the
// "we're in the full cli-e2e-ci runner" signal (see stop.live.test.ts's own
// comment for why this, not a Management-API gate, is correct here). See
// AGENTS.md's "Live tests" section for the full convention.
describeLive("supabase start (live)", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    // Best-effort cleanup even if an assertion above failed mid-lifecycle — a
    // leaked local stack would otherwise pollute the CI runner for later jobs.
    await runSupabaseLive(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
  });

  test(
    "starts a reduced real local stack, running only the non-excluded containers",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-start-live-"));
      // No `project_id` override, so the cli resolves it from the workdir
      // basename — matching Go's precedence exactly (see legacy-docker-ids.ts).
      // Sanitizing is a no-op for a `mkdtemp`-generated basename (already
      // alphanumeric/`-`), but mirrors the port's actual resolution rather
      // than assuming that stays true.
      const projectId = legacySanitizeProjectId(path.basename(projectDir));

      const init = await runSupabaseLive(["init"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      // The real Docker daemon must agree with the CLI's own exit code: every
      // non-excluded service is actually running under this project's label,
      // AND every excluded service is genuinely absent — not merely reported
      // "stopped" by a status diff.
      const { stdout: psOutput } = await execFileAsync("docker", [
        "ps",
        "--filter",
        `label=com.supabase.cli.project=${projectId}`,
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

      const status = await runSupabaseLive(["status"], {
        cwd: projectDir,
        exitTimeoutMs: SHORT_LIVE_TIMEOUT_MS,
      });
      expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
    },
  );
});
