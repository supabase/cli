/**
 * The shadow baseline cache's one subprocess scenario (golden path only): running the same
 * `db diff` invocation twice against a real local stack must cold-publish a
 * `shadow-baseline-<key>.tar` on the first run, warm-restore that exact tar on the second, and
 * produce byte-identical diff output either way.
 *
 * Proves what only real process wiring can: that `db diff` routes through
 * `acquireShadowDatabase`, that the cache engages with `SUPABASE_SHADOW_CACHE` genuinely unset
 * (the shipped default), that the cache directory survives a real process boundary, that the
 * cache key is stable across two separate CLI processes, and that a warm-restored cluster
 * yields the same migration SQL as a cold-provisioned one.
 *
 * The acquire/export/restore mechanics are covered exhaustively by
 * `shadow-cache.integration.test.ts`, and the pure key/retention logic by
 * `shadow-cache.unit.test.ts`. Nothing branch-shaped belongs here.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../tests/helpers/cli.ts";

const CLEANUP_TIMEOUT_MS = 120_000;

const START_TIMEOUT_MS = 280_000;
const DIFF_TIMEOUT_MS = 180_000;
// One full `start` plus the cold/warm `db diff` pair, with lifecycle overhead for `init`,
// filesystem inspection, and fast-failing port-conflict retries.
const LIFECYCLE_OVERHEAD_MS = 90_000;

/**
 * `db diff`'s shadow port. Docker has to bind it, so a test cannot truly reserve it up front —
 * retry on the next candidate (derived from this process's pid, so concurrent runs don't race for
 * one shared port) when the CLI reports a real bind conflict.
 *
 * Fed through `SUPABASE_DB_SHADOW_PORT` rather than rewriting the generated `config.toml`, so the
 * `init` template stays exactly as a user's would be. Not part of the cache key, so retrying on a
 * different port cannot change which tar the run looks for.
 */
const SHADOW_PORT_CANDIDATE_COUNT = 8;
const SHADOW_PORT_BASE = 49152 + ((process.pid * 37) % (16384 - SHADOW_PORT_CANDIDATE_COUNT));
const SHADOW_PORT_CANDIDATES: ReadonlyArray<number> = Array.from(
  { length: SHADOW_PORT_CANDIDATE_COUNT },
  (_, index) => SHADOW_PORT_BASE + index,
);

const DIFF_ARGS = ["db", "diff", "--local", "--use-pg-delta"] as const;

/** `shadow-cache.ts`'s published artifact name — `shadow-baseline-<16 hex key>.tar`. */
const BASELINE_TAR_PATTERN = /^shadow-baseline-[0-9a-f]{16}\.tar$/u;

/** Docker's own bind-conflict wording on stderr; only used to decide whether to retry. */
function isShadowPortConflict(stderr: string): boolean {
  return /port is already allocated|address already in use|Bind for \S+ failed/iu.test(stderr);
}

async function baselineTars(cacheDir: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(cacheDir).catch(() => [] as Array<string>);
  return entries.filter((entry) => entry.endsWith(".tar")).sort();
}

describe("shadow baseline cache (e2e, local Docker stack)", () => {
  let projectDir: string | undefined;
  let home: ReturnType<typeof makeTempHome> | undefined;

  afterEach(async () => {
    if (projectDir !== undefined) {
      // Best-effort cleanup even if an assertion above failed mid-lifecycle — a leaked local
      // stack would otherwise pollute the CI runner for later jobs.
      await runSupabase(["stop", "--no-backup"], {
        cwd: projectDir,
        exitTimeoutMs: CLEANUP_TIMEOUT_MS,
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
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-shadow-cache-e2e-"));
      // One temp `SUPABASE_HOME` per test run so both `db diff` processes share the same cache
      // directory; `runSupabase` otherwise mints a fresh home per invocation.
      home = makeTempHome();
      const cacheDir = path.join(home.dir, "cache", "shadow-baseline");

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        home: home.dir,
      });
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      // Exclude the heaviest, least relevant services — `db diff` only needs the local Postgres
      // container reachable, same rationale as stop/status/diff.
      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { cwd: projectDir, home: home.dir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      // Same drift setup as `db/diff/diff.declarative.e2e.test.ts`: create a fresh function
      // directly in the local database so `db diff --local` has real, deterministic SQL to
      // produce — the byte-identity of that output across cold/warm runs is the actual
      // user-visible contract here. Schema files can't supply this drift since the next engine
      // ignores `schema_paths` when building its migrations baseline.
      const createFunction = await runSupabase(
        [
          "db",
          "query",
          `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;`,
          "--local",
        ],
        { cwd: projectDir, home: home.dir },
      );
      expect(
        createFunction.exitCode,
        `stdout:\n${createFunction.stdout}\nstderr:\n${createFunction.stderr}`,
      ).toBe(0);

      let cold: Awaited<ReturnType<typeof runSupabase>> | undefined;
      let warm: Awaited<ReturnType<typeof runSupabase>> | undefined;
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
            // Remove the harness's isolation pin (`spawnSupabase` injects `=0`) so the suite
            // runs with the key genuinely absent — the shipped default-on state — rather than
            // an explicit opt-in.
            SUPABASE_SHADOW_CACHE: undefined,
            SUPABASE_DB_SHADOW_PORT: String(shadowPort),
          },
        };

        const first = await runSupabase([...DIFF_ARGS], diffOptions);
        if (first.exitCode !== 0 && canRetry && isShadowPortConflict(first.stderr)) continue;
        cold = first;
        coldTars = await baselineTars(cacheDir);
        if (coldTars.length === 1) {
          coldMtimeMs = (await stat(path.join(cacheDir, coldTars[0]!))).mtimeMs;
        }
        // A genuine cold-run failure is reported below rather than spending another full
        // `DIFF_TIMEOUT_MS` on a warm run that has no snapshot to restore.
        if (first.exitCode !== 0) break;

        const second = await runSupabase([...DIFF_ARGS], diffOptions);
        if (second.exitCode !== 0 && canRetry && isShadowPortConflict(second.stderr)) {
          cold = undefined;
          continue;
        }
        warm = second;
        break;
      }

      // Run 1 (cold): the baseline was provisioned and exported as one keyed tar.
      expect(cold, "every candidate shadow port reported a bind conflict").toBeDefined();
      if (cold === undefined) return;
      expect(cold.exitCode, `stdout:\n${cold.stdout}\nstderr:\n${cold.stderr}`).toBe(0);
      expect(coldTars, `cache dir: ${cacheDir}\nstderr:\n${cold.stderr}`).toHaveLength(1);
      expect(coldTars[0]).toMatch(BASELINE_TAR_PATTERN);

      // Run 2 (warm): the same key restored that snapshot instead of rebuilding it.
      expect(warm).toBeDefined();
      if (warm === undefined) return;
      expect(warm.exitCode, `stdout:\n${warm.stdout}\nstderr:\n${warm.stderr}`).toBe(0);
      // Neither degradation path may have engaged — both warn on stderr before falling back to a
      // cold provision, and either would otherwise hide a broken warm path behind a passing run.
      expect(warm.stderr).not.toContain("cached shadow baseline unusable");
      expect(warm.stderr).not.toContain("shadow baseline not cached");
      const warmTars = await baselineTars(cacheDir);
      expect(warmTars).toEqual(coldTars);
      // Warm hits refresh mtime so a frequently used key survives LRU/TTL retention.
      const warmMtimeMs = (await stat(path.join(cacheDir, warmTars[0]!))).mtimeMs;
      expect(warmMtimeMs).toBeGreaterThan(coldMtimeMs);

      // stdout carries the migration SQL (no `-f`, so `db diff` prints it); a restored cluster
      // must diff to exactly the same statements as a freshly baselined one. The regex tolerates
      // pretty-print variations (quoting/whitespace), same anchor as
      // `diff.declarative.e2e.test.ts`.
      expect(cold.stdout).toMatch(
        /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)/i,
      );
      expect(warm.stdout).toBe(cold.stdout);
    },
  );
});
