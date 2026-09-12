import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../tests/helpers/cli.ts";

// A fake-but-well-formed token bypasses the eager SUPABASE_ACCESS_TOKEN check, so the run
// reaches this command's own handler instead of failing generically first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("config pull CLI surface", () => {
  test("plain `config pull` parses — no boolean flag is accidentally required", async () => {
    // A Flag.Boolean without Flag.withDefault(false) is a required flag, so a missing default
    // on --dry-run/--force would fail plain `supabase config pull`. Integration tests hand the
    // handler pre-built flags and never exercise the parser, so this needs pinning at the
    // subprocess boundary.
    const cwd = await mkdtemp(join(tmpdir(), "supabase-config-pull-e2e-"));
    try {
      const { stdout, stderr } = await runSupabase(["config", "pull"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      // Positive anchor: this hermetic cwd has no config file, so only a run that actually
      // reached the handler prints this exact load error — a vacuously-green regression (e.g.
      // the binary failing to start) wouldn't.
      expect(combined).toContain(
        "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
