import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration new (legacy)", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "sb-mig-new-e2e-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // Primary golden path: a real subprocess creates the migration file under the
  // working directory and prints the workdir-relative path. No infra required.
  test(
    "creates a timestamped migration file and prints its path",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["migration", "new", "create_widgets"], {
        entrypoint: "legacy",
        cwd: workdir,
      });

      expect(exitCode).toBe(0);
      const files = readdirSync(join(workdir, "supabase", "migrations"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_create_widgets\.sql$/u);
      expect(stripAnsi(stdout)).toContain(
        `Created new migration at supabase/migrations/${files[0]}`,
      );
    },
  );
});
