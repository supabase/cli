/**
 * The shadow baseline cache's ONE live scenario (golden path only, per the repo's live-test
 * policy): the SAME `db diff` invocation run TWICE against a real local stack must cold-publish a
 * `shadow-baseline-<key>.tar` on the first run, warm-restore that exact tar on the second, and
 * produce byte-identical diff output either way.
 *
 * A black-box `runSupabaseLive` subprocess test, like every other `*.live.test.ts` in this
 * workspace: the facts it is here to prove are the ones only the real wiring can — that `db diff`
 * actually routes through `legacyAcquireShadowDatabase`, that the cache's env gates
 * (`SUPABASE_SHADOW_CACHE`/`SUPABASE_SHADOW_DEBUG`) and its `${SUPABASE_HOME}/cache/shadow-baseline`
 * artifact location survive a real process boundary, that the cache key is STABLE across two
 * separate CLI processes (an in-process test computes it once), and that a warm-restored cluster
 * yields the same migration SQL as a cold-provisioned one. It replaces an earlier in-process
 * version of this file that called `legacyAcquireShadowDatabase` directly with a synthetic layer
 * graph — that shape could stay green while the `db diff` wiring, the env propagation, or the cache
 * enablement was broken.
 *
 * The acquire/export/restore MECHANICS (cold export, warm restore, tar validation and rejection,
 * retention/LRU, cache-off and bypass paths) are covered exhaustively by
 * `shadow-cache.integration.test.ts` against its in-test Docker model plus a real filesystem, and
 * the pure key/retention logic by `shadow-cache.unit.test.ts`. Nothing branch-shaped belongs here.
 *
 * Gated with `describeDockerLive` (the cli-e2e-ci signal composed with a `docker info` probe, since
 * this is a Docker-only local-stack suite).
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { makeTempHome } from "../../../../tests/helpers/cli.ts";
import { describeDockerLive, runSupabaseLive } from "../../../../tests/helpers/live.ts";

const START_TIMEOUT_MS = 280_000;
const DIFF_TIMEOUT_MS = 180_000;
// One full `start` plus the cold/warm `db diff` pair, with lifecycle overhead for `init`, the
// filesystem inspection between runs, and the fast-failing port-conflict retries below (a
// conflicting publish fails in `docker create`/`start`, i.e. seconds, never a whole
// `DIFF_TIMEOUT_MS`) — same "budget each subprocess separately" shape as `diff.live.test.ts`.
const LIFECYCLE_OVERHEAD_MS = 90_000;

/**
 * `db diff`'s shadow port, published on the host by the shadow container. Docker itself has to
 * bind it, so a test CANNOT truly reserve it up front: binding a listener and releasing it proves
 * nothing about the window between the release and the container's own bind. The honest mitigation
 * is therefore two-part — pick ports far from the `[db] shadow_port` default (54320) that a stray
 * local stack or a neighbouring suite would be holding, and retry the scenario on the next
 * candidate when the CLI reports a real bind conflict.
 *
 * Fed through `SUPABASE_DB_SHADOW_PORT` (`legacy-db-config.toml-read.ts`'s `envOverride`) rather
 * than by rewriting the generated `config.toml`, so the `init` template stays exactly as a user's
 * would be. The port is deliberately NOT part of the cache key (see `legacyShadowCacheKey`), so
 * retrying on a different one cannot change which tar the run looks for.
 */
const SHADOW_PORT_CANDIDATES = [54987, 54988] as const;

const DIFF_ARGS = ["db", "diff", "--local", "--use-pg-delta"] as const;

/** `shadow-cache.ts`'s published artifact name — `shadow-baseline-<16 hex key>.tar`. */
const BASELINE_TAR_PATTERN = /^shadow-baseline-[0-9a-f]{16}\.tar$/u;

/**
 * Docker's own bind-conflict wording, as it reaches stderr through the shadow's
 * `docker create`/`docker start` failure. Only used to decide whether to retry on another
 * candidate port — never asserted on.
 */
function isShadowPortConflict(stderr: string): boolean {
  return /port is already allocated|address already in use|Bind for \S+ failed/iu.test(stderr);
}

async function baselineTars(cacheDir: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(cacheDir).catch(() => [] as Array<string>);
  return entries.filter((entry) => entry.endsWith(".tar")).sort();
}

describeDockerLive("shadow baseline cache (live Docker)", () => {
  let projectDir: string | undefined;
  let home: ReturnType<typeof makeTempHome> | undefined;

  afterEach(async () => {
    if (projectDir !== undefined) {
      // Best-effort cleanup even if an assertion above failed mid-lifecycle — a leaked local
      // stack would otherwise pollute the CI runner for later jobs.
      await runSupabaseLive(["stop", "--no-backup"], {
        cwd: projectDir,
        ...(home === undefined ? {} : { home: home.dir }),
      }).catch(() => undefined);
      await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    }
    // Disposes the temp `SUPABASE_HOME`, and with it the ~90MB baseline tar this suite published.
    home?.[Symbol.dispose]();
    projectDir = undefined;
    home = undefined;
  });

  test(
    "publishes a baseline snapshot on the first db diff, then restores it on the second with identical output",
    { timeout: START_TIMEOUT_MS + 2 * DIFF_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-shadow-cache-live-"));
      // One temp `SUPABASE_HOME` for every run in this test, so the two `db diff` processes share
      // the global `${SUPABASE_HOME}/cache/shadow-baseline` directory the cache publishes into —
      // `runSupabase` otherwise mints (and disposes) a fresh home per invocation, which would make
      // every run a cold one.
      home = makeTempHome();
      const cacheDir = path.join(home.dir, "cache", "shadow-baseline");

      const init = await runSupabaseLive(["init"], { cwd: projectDir, home: home.dir });
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      // Same declarative setup as `db/diff/diff.live.test.ts`: point `[db.migrations]
      // schema_paths` at a schema directory so `db diff --local` has real, deterministic SQL to
      // produce — the payload whose byte-identity across the cold and warm runs is the actual
      // user-visible contract here. Paths are relative to `supabase/`.
      const configPath = path.join(projectDir, "supabase", "config.toml");
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain("schema_paths = []");
      writeFileSync(
        configPath,
        config.replace("schema_paths = []", 'schema_paths = ["./schemas/*.sql"]'),
      );
      const schemasDir = path.join(projectDir, "supabase", "schemas");
      mkdirSync(schemasDir, { recursive: true });
      writeFileSync(
        path.join(schemasDir, "01_probe_fn.sql"),
        `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;
`,
      );

      // Exclude the heaviest, least relevant services — `db diff` only needs the local Postgres
      // container reachable, same rationale as stop/status/diff.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, home: home.dir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      let cold: Awaited<ReturnType<typeof runSupabaseLive>> | undefined;
      let warm: Awaited<ReturnType<typeof runSupabaseLive>> | undefined;
      let coldTars: ReadonlyArray<string> = [];
      let coldMtimeMs = 0;

      for (const [index, shadowPort] of SHADOW_PORT_CANDIDATES.entries()) {
        const canRetry = index < SHADOW_PORT_CANDIDATES.length - 1;
        // Each attempt must start from an empty cache, or the previous attempt's tar would make
        // this attempt's first run a warm one.
        await rm(cacheDir, { recursive: true, force: true });
        const diffOptions = {
          cwd: projectDir,
          home: home.dir,
          exitTimeoutMs: DIFF_TIMEOUT_MS,
          env: {
            // The e2e/live harness pins this to "0" by default so ordinary suites never leave a
            // ~90MB tar behind; this suite's subject IS the cache, so it opts back in.
            SUPABASE_SHADOW_CACHE: "1",
            // Turns on `shadow-debug.ts`'s stderr phase lines, which name the path actually taken
            // (`baseline-export` cold, `baseline-restore` warm).
            SUPABASE_SHADOW_DEBUG: "1",
            SUPABASE_DB_SHADOW_PORT: String(shadowPort),
          },
        };

        const first = await runSupabaseLive([...DIFF_ARGS], diffOptions);
        if (first.exitCode !== 0 && canRetry && isShadowPortConflict(first.stderr)) continue;
        cold = first;
        coldTars = await baselineTars(cacheDir);
        if (coldTars.length === 1) {
          coldMtimeMs = (await stat(path.join(cacheDir, coldTars[0]!))).mtimeMs;
        }
        // A genuine cold-run failure is reported below rather than spending another full
        // `DIFF_TIMEOUT_MS` on a warm run that has no snapshot to restore.
        if (first.exitCode !== 0) break;

        const second = await runSupabaseLive([...DIFF_ARGS], diffOptions);
        if (second.exitCode !== 0 && canRetry && isShadowPortConflict(second.stderr)) {
          cold = undefined;
          continue;
        }
        warm = second;
        break;
      }

      // --- Run 1: cold. The baseline was provisioned and exported as one keyed tar. ---
      expect(cold, "every candidate shadow port reported a bind conflict").toBeDefined();
      if (cold === undefined) return;
      expect(cold.exitCode, `stdout:\n${cold.stdout}\nstderr:\n${cold.stderr}`).toBe(0);
      expect(cold.stderr).toContain("shadow-debug: baseline-export");
      expect(cold.stderr).not.toContain("shadow-debug: baseline-restore");
      // The artifact is a plain file under the global per-settings cache — the property that lets
      // worktrees with the same settings share a warm hit, and a future native (non-Docker)
      // Postgres service consume the same snapshot.
      expect(coldTars, `cache dir: ${cacheDir}\nstderr:\n${cold.stderr}`).toHaveLength(1);
      expect(coldTars[0]).toMatch(BASELINE_TAR_PATTERN);

      // --- Run 2: warm. The same key restored that snapshot instead of rebuilding it. ---
      expect(warm).toBeDefined();
      if (warm === undefined) return;
      expect(warm.exitCode, `stdout:\n${warm.stdout}\nstderr:\n${warm.stderr}`).toBe(0);
      expect(warm.stderr).toContain("shadow-debug: baseline-restore");
      expect(warm.stderr).not.toContain("shadow-debug: baseline-export");
      // Neither degradation path may have engaged — both warn on stderr before falling back to a
      // cold provision, and either would otherwise hide a broken warm path behind a passing run.
      expect(warm.stderr).not.toContain("cached shadow baseline unusable");
      expect(warm.stderr).not.toContain("shadow baseline not cached");
      // Same single tar, same filename: the key is reproducible across processes, and the warm run
      // published nothing of its own.
      const warmTars = await baselineTars(cacheDir);
      expect(warmTars).toEqual(coldTars);
      // Warm hits refresh mtime so a frequently used key survives LRU/TTL retention.
      const warmMtimeMs = (await stat(path.join(cacheDir, warmTars[0]!))).mtimeMs;
      expect(warmMtimeMs).toBeGreaterThan(coldMtimeMs);

      // The user-visible contract is unchanged by which path ran: stdout carries the migration SQL
      // (no `-f`, so `db diff` prints it), and a restored cluster must diff to exactly the same
      // statements as a freshly baselined one.
      expect(cold.stdout).toContain("CREATE FUNCTION public.probe_fn()");
      expect(warm.stdout).toBe(cold.stdout);
    },
  );
});
