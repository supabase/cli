import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db reset (legacy)", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "sb-db-reset-e2e-"));
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), "[db]\nport = 54322\n");
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // Docker-free: the destructive remote-reset confirmation fires after the config
  // load and BEFORE any connection is dialed, so a piped decline exits without a
  // database. Declining must byte-match Go: a single `context canceled` line on
  // stderr and exit 1, with NO `--debug` troubleshooting hint — `recoverAndExit`
  // skips `SuggestDebugFlag` for `context.Canceled` (apps/cli-go/cmd/root.go:287-303).
  // CLI-1973.
  test(
    "declining the remote reset prompt prints only context canceled, no --debug hint",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(
        ["db", "reset", "--db-url", "postgresql://postgres:postgres@127.0.0.1:9999/postgres"],
        { entrypoint: "legacy", cwd: workdir, stdin: "n\n" },
      );
      expect(exitCode).toBe(1);
      // The destructive confirmation (default No → `[y/N]`) actually rendered and
      // was answered — the cancellation didn't come from some other failure path.
      expect(stripAnsi(stderr)).toContain("[y/N]");
      const lines = stripAnsi(stderr).trimEnd().split("\n");
      expect(lines.at(-1)).toBe("context canceled");
      expect(stderr).not.toContain("Try rerunning the command with --debug");
    },
  );
});
