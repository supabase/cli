import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

// A fake-but-well-formed token (bypasses the auth-layer's own eager
// `SUPABASE_ACCESS_TOKEN` check, same precedent as push's e2e test) so the
// run reaches this command's own handler instead of failing generically on
// "Access token not provided" first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("config diff CLI surface", () => {
  test("plain `config diff` parses — no boolean flag is accidentally required", async () => {
    // Parser-level regression pin (PR #6295 review): a `Flag.boolean` without
    // `Flag.withDefault(false)` is a REQUIRED flag, so the help's own first
    // example (`supabase config diff`) failed with `required flag(s)
    // "exit-code" not set`. Integration tests hand the handler a pre-built
    // flags object and never exercise the parser, so this must be pinned at
    // the subprocess boundary.
    const cwd = await mkdtemp(join(tmpdir(), "supabase-config-diff-e2e-"));
    try {
      const { stdout, stderr } = await runSupabase(["config", "diff"], {
        entrypoint: "legacy",
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      // Positive anchor: this hermetic cwd has no `supabase/config.toml` or
      // `supabase/config.json`, so a run that actually reached the handler
      // (not just a binary-launch failure) surfaces this exact load error.
      // A vacuously-green regression here (e.g. the binary failing to start
      // at all) would NOT print this fragment.
      expect(combined).toContain(
        "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
