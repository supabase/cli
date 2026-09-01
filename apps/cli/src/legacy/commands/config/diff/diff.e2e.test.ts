import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

describe("config diff CLI surface", () => {
  test("plain `config diff` parses — no boolean flag is accidentally required", async () => {
    // Parser-level regression pin (PR #6295 review): a `Flag.boolean` without
    // `Flag.withDefault(false)` is a REQUIRED flag, so the help's own first
    // example (`supabase config diff`) failed with `required flag(s)
    // "exit-code" not set`. Integration tests hand the handler a pre-built
    // flags object and never exercise the parser, so this must be pinned at
    // the subprocess boundary. The invocation is expected to fail LATER (no
    // linked project in this hermetic cwd/HOME) — the assertion is only that
    // it gets past the parser.
    const cwd = await mkdtemp(join(tmpdir(), "supabase-config-diff-e2e-"));
    try {
      const { stdout, stderr } = await runSupabase(["config", "diff"], {
        entrypoint: "legacy",
        cwd,
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      expect(combined).not.toContain("exit-code");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
