import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const TIMEOUT_MS = 10_000;

// Regression coverage for CLI-1489: a config.toml containing `env(VAR)`
// references on non-string fields (numeric ports here) must not crash the
// Bun shell when it materializes the project context. v2.99.0 eagerly
// decoded config.toml through a strict Effect schema and rejected the
// literal "env(...)" string against Schema.Number, breaking every command
// that pulls CliConfig — including the legacy db start path the customer
// hit. This test boots a real subprocess against such a config and
// asserts the shell does not fail with ProjectConfigParseError.
describe("projectContextLayer (e2e)", () => {
  test(
    "tolerates env() references on numeric fields in supabase/config.toml",
    { timeout: TIMEOUT_MS },
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "supabase-cli-1489-"));
      const projectRoot = join(tempDir, "repo");

      try {
        await mkdir(join(projectRoot, "supabase"), { recursive: true });
        await writeFile(
          join(projectRoot, "supabase", "config.toml"),
          [
            'project_id = "with-env-ports"',
            "",
            "[api]",
            'port = "env(SUPABASE_API_PORT)"',
            "",
            "[db]",
            'port = "env(SUPABASE_DB_PORT)"',
            "",
            "[analytics]",
            'port = "env(SUPABASE_ANALYTICS_PORT)"',
            "",
          ].join("\n"),
        );

        const { stdout, stderr, exitCode } = await runSupabase(["stack", "list"], {
          cwd: projectRoot,
          env: {
            SUPABASE_API_PORT: "54321",
            SUPABASE_DB_PORT: "54322",
            SUPABASE_ANALYTICS_PORT: "54327",
          },
        });

        const combined = `${stdout}\n${stderr}`;
        expect(combined).not.toContain("ProjectConfigParseError");
        expect(combined).not.toContain("Expected number");
        expect(exitCode).toBe(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
