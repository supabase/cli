import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;

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
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      // `init`'s template already enables pg-delta by default (CLI-1877/#5511), but
      // point `[db.migrations] schema_paths` at a declarative schema directory so
      // `db diff --local` diffs against it instead of the (empty) local migration
      // history. Go's `db.go:426` docs the exact syntax: paths relative to `supabase/`.
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
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

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

// CLI-1968: `--use-pgadmin` is a native `docker run` of the differ container, no
// edge-runtime and no Go delegation involved. Golden-path smoke coverage only — the
// pure filtering/progress logic and the docker-run argv are covered exhaustively by
// `legacy-pgadmin-diff.unit.test.ts` and `diff.integration.test.ts`; this just proves
// the real container actually runs against a real local stack and cleans up after
// itself. See `SIDE_EFFECTS.md`'s "Deliberate divergence" entry: the real Go binary's
// `DiffStream` value-receiver bug means the Go CLI would always report "No schema
// changes found" here regardless of the differ's actual output — that divergence is
// exactly why this suite exists, not something this test itself asserts on.
describeLive("supabase db diff (live, --use-pgadmin native differ container)", () => {
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
    "golden path: diffs the local db with the native pgAdmin differ container and leaves no differ container behind",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-db-diff-pgadmin-live-"));

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      // Exclude the heaviest, least relevant services — `db diff --use-pgadmin` only
      // needs the local Postgres container reachable, same rationale as stop/status.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      const diff = await runSupabaseLive(["db", "diff", "--use-pgadmin"], {
        cwd: projectDir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      // A freshly-`init`'d project has no drift against its own (empty) migration
      // history — "No schema changes found" on stderr, exit 0, same golden-path
      // semantics as the migra/pg-delta engines.
      expect(diff.exitCode, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0);
      expect(diff.stderr).toContain("No schema changes found");

      // The differ is a one-shot `docker run --rm` — real Docker must agree that no
      // container survives it, the same "the daemon must agree" check
      // `stop.live.test.ts` runs against `com.supabase.cli.project`.
      const { stdout: remaining } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        "ancestor=supabase/pgadmin-schema-diff:cli-0.0.5",
        "--format",
        "{{.ID}}",
      ]);
      expect(remaining.trim()).toBe("");
    },
  );
});
