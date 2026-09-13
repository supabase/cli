import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../tests/helpers/cli.ts";

// A well-formed token bypasses the auth layer's eager `SUPABASE_ACCESS_TOKEN` check, so the run
// reaches this command's own handler instead of failing on "Access token not provided" first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("pull CLI surface", () => {
  test("plain `supabase pull` parses its flags and fails on target resolution, not argument parsing", async () => {
    // A loadable config.toml with no project_id/ref-file state is required to get past config
    // loading and into `resolveConfigTarget`, which this test exercises.
    const cwd = await mkdtemp(join(tmpdir(), "supabase-pull-e2e-"));
    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "test"\n');

      const { exitCode, stderr } = await runSupabase(["pull"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const cleanStderr = stripAnsi(stderr);
      expect(cleanStderr).not.toContain("required flag");
      expect(cleanStderr).not.toContain("Unrecognized flag");
      expect(cleanStderr).toContain("Cannot find project ref. Have you run supabase link?");
      expect(exitCode).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("`supabase pull -o json` is rejected by the handler, pointing at --output-format", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "supabase-pull-e2e-"));
    try {
      const { exitCode, stderr } = await runSupabase(["pull", "-o", "json"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const cleanStderr = stripAnsi(stderr);
      expect(cleanStderr).not.toContain("Unrecognized flag");
      expect(cleanStderr).not.toContain("invalid choice");
      expect(cleanStderr).toContain(
        "the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.",
      );
      expect(exitCode).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
