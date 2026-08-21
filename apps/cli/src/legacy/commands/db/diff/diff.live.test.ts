import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";
import { requireLiveSuccess } from "../../../../../tests/helpers/live-context.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;
// Lifecycle allowance for scenarios that run TWO full-budget subprocesses (`start`
// then the command under test) plus init/inspection overhead — same shape as
// `start.live.test.ts`. A single shared `START_TIMEOUT_MS` test budget would let a
// slow-but-valid `start` starve the command under test before it ever runs.
const LIFECYCLE_OVERHEAD_MS = 90_000;

// CLI-1947 regression: pg-delta's `filterPublicBuiltInDefaults()` unconditionally
// treated PUBLIC's implicit built-in privilege as a no-op on both sides of a diff,
// so a declarative schema's `REVOKE ... FROM PUBLIC` on a function was silently
// dropped from the generated migration — exit code 0, no error, just a missing
// statement. Fixed upstream in @supabase/pg-delta@1.0.0-alpha.33
// (supabase/pg-toolbelt#357). Verified directly against this repo's build: with
// the pre-fix pin (1.0.0-alpha.32) the migration below contains only the CREATE
// FUNCTION statement; the REVOKE is silently absent. `describeLive` is reused as
// the "real local Docker stack is available" signal, same as stop/status — this
// never calls the Management API. See AGENTS.md's "Live tests" section.
describeLive("supabase db diff (live, pg-delta declarative privileges)", () => {
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
    "keeps REVOKE ... FROM PUBLIC on a function when diffing a declarative schema against local",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-db-diff-live-"));

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      requireLiveSuccess(init, "init setup");

      // `init`'s template already enables pg-delta by default (CLI-1877/#5511), but
      // point `[db.migrations] schema_paths` at a declarative schema directory so
      // `db diff --local` diffs against it instead of the (empty) local migration
      // history. Paths are relative to `supabase/`.
      const configPath = path.join(projectDir, "supabase", "config.toml");
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain("schema_paths = []");
      writeFileSync(
        configPath,
        config.replace("schema_paths = []", 'schema_paths = ["./schemas/*.sql"]'),
      );

      // Minimal, deterministic repro: a fresh function's implicit PUBLIC EXECUTE
      // grant, explicitly revoked. Verified empirically against this build: pre-fix
      // (pg-delta 1.0.0-alpha.32) the generated migration contains only the CREATE
      // FUNCTION statement; the REVOKE is silently dropped.
      const schemasDir = path.join(projectDir, "supabase", "schemas");
      mkdirSync(schemasDir, { recursive: true });
      writeFileSync(
        path.join(schemasDir, "01_probe_fn.sql"),
        `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;

revoke execute on function public.probe_fn() from public;
`,
      );

      // Exclude the heaviest, least relevant services — `db diff` only needs the
      // local Postgres container reachable, same rationale as stop/status.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireLiveSuccess(start, "start setup");

      const diff = await runSupabaseLive(
        ["db", "diff", "--local", "--use-pg-delta", "-f", "revoke_public_execute"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(diff.exitCode, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0);

      const migrationsDir = path.join(projectDir, "supabase", "migrations");
      const written =
        existsSync(migrationsDir) &&
        readdirSync(migrationsDir).find((f) => f.endsWith("_revoke_public_execute.sql"));
      expect(written, `no migration written; stderr:\n${diff.stderr}`).toBeTruthy();
      const sql = readFileSync(path.join(migrationsDir, written as string), "utf8");

      // The negative-space regression: pre-fix, exit code 0 and this file would
      // exist, but silently missing the REVOKE statement (only the CREATE FUNCTION
      // survives). Anchor the match to the function's own REVOKE statement — up to
      // its terminating `;` — so this cannot pass on an unrelated PUBLIC mention
      // elsewhere in the file.
      expect(sql).toContain("CREATE FUNCTION public.probe_fn()");
      expect(sql).toMatch(
        /REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+public\.probe_fn\(\)\s+FROM\s+[^;]*PUBLIC[^;]*;/i,
      );
    },
  );
});

// `--use-pgadmin` is a native `docker run` of the differ container, no
// edge-runtime and no Go delegation involved. Golden-path smoke coverage only — the
// pure filtering/progress logic and the docker-run argv are covered exhaustively by
// `legacy-pgadmin-diff.unit.test.ts` and `diff.integration.test.ts`; this just proves
// the real container actually runs against a real local stack and cleans up after
// itself either way.
//
// The real, reachable outcome here is a FAILURE, not a golden diff, by design: the
// differ container joins the project's own bridge network
// (`supabase_network_<projectId>`), and both diff endpoints are hardcoded loopback
// URLs from that container's own point of view — `source` (resolving to `127.0.0.1`
// for a local target) and `target`
// (`postgresql://postgres:postgres@127.0.0.1:<shadowPort>/postgres`). Inside a
// bridge-attached container, `127.0.0.1` is the container's OWN loopback, not the
// host's — so neither the local db nor the shadow is reachable from inside the
// differ, and the container exits non-zero. See `SIDE_EFFECTS.md`'s "Network
// reachability" entry for the full static ruling. (The historical value-receiver bug
// documented there — always reporting "No schema changes found" regardless of the
// differ's actual output — only ever engages when the differ container exits 0; it
// plays no role in this failure path.) Note that a plain `--network-id host` does NOT
// rescue a golden run here: it also rewires the SHADOW container onto host
// networking, discarding its own `54320->5432` port publish that `target` depends on
// — so `source` would become reachable but `target` would not, still failing the
// diff. This suite therefore verifies the real, always-reachable failure mode
// end-to-end, plus that both the differ AND the shadow container it provisions are
// still cleaned up.
describeLive("supabase db diff (live, --use-pgadmin native differ container)", () => {
  let projectDir: string | undefined;
  let projectId: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    // Best-effort cleanup even if an assertion above failed mid-lifecycle — a
    // leaked local stack would otherwise pollute the CI runner for later jobs.
    await runSupabaseLive(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
    projectId = undefined;
  });

  test(
    "runs the native differ container against the real stack, surfaces Go's error running container failure, and leaves no differ container behind",
    { timeout: START_TIMEOUT_MS * 2 + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-db-diff-pgadmin-live-"));
      // No `project_id` override, so the cli resolves it from the workdir basename
      // (see legacy-docker-ids.ts), same as `stop.live.test.ts`.
      projectId = path.basename(projectDir);

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      requireLiveSuccess(init, "init setup");

      // Exclude the heaviest, least relevant services — `db diff --use-pgadmin` only
      // needs the local Postgres container reachable, same rationale as stop/status.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireLiveSuccess(start, "start setup");

      const diff = await runSupabaseLive(["db", "diff", "--use-pgadmin"], {
        cwd: projectDir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      // Both hardcoded loopback endpoints are unreachable from inside the
      // bridge-attached differ container (see this suite's own header comment for the
      // full, static ruling) — the differ exits non-zero and the CLI surfaces its own
      // wrapper message. The differ's own exit code isn't pinned: only that the differ
      // ran and failed, not the shadow/connection machinery around it.
      expect(diff.exitCode, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(1);
      expect(diff.stderr).toContain("error running container: exit ");

      // The differ is a one-shot `docker run --rm` — real Docker must agree that no
      // container survives it, the same "the daemon must agree" check
      // `stop.live.test.ts` runs against `com.supabase.cli.project`.
      const { stdout: remainingDiffer } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        "ancestor=supabase/pgadmin-schema-diff:cli-0.0.5",
        "--format",
        "{{.ID}}",
      ]);
      expect(remainingDiffer.trim()).toBe("");

      // This failure path exercises the shadow's `acquireUseRelease` teardown for
      // real (the differ error propagates out of the `use` phase after the shadow was
      // already created) — the shadow itself is created with no `--name` (Docker
      // auto-generates one), unlike every real stack container, which is always named
      // `supabase_<service>_<projectId>`. So a leaked shadow shows up as a
      // project-labeled container whose name does NOT carry that fixed prefix.
      const { stdout: projectContainers } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `label=com.supabase.cli.project=${projectId}`,
        "--format",
        "{{.Names}}",
      ]);
      const names = projectContainers
        .trim()
        .split("\n")
        .filter((name) => name.length > 0);
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((name) => name.startsWith("supabase_"))).toBe(true);
    },
  );
});
