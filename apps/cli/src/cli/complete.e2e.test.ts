import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { makeTempCliProject, makeTempHome, runSupabase } from "../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase __complete", () => {
  test(
    "migration li completes to list with a description and the NoFileComp directive",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["__complete", "migration", "li"], {});
      expect(exitCode).toBe(0);
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe("list\tList local and remote migrations");
      expect(lines.at(-1)).toBe(":4");
    },
  );

  test(
    "__completeNoDesc strips the description from the same candidate",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["__completeNoDesc", "migration", "li"], {});
      expect(exitCode).toBe(0);
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe("list");
      expect(lines.at(-1)).toBe(":4");
    },
  );

  test("root-level flag-name completion offers --debug", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout } = await runSupabase(["__complete", "--d"], {});
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--debug\toutput debug logs to stderr");
  });

  test(
    "routes complete command paths and keeps malformed config on the legacy tree",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const project = await makeTempCliProject("supabase-completion-routing-e2e-");
      const home = makeTempHome();
      try {
        await mkdir(path.join(project.dir, "supabase"), { recursive: true });
        await writeFile(path.join(project.dir, "supabase", "config.toml"), "[experimental\n");

        const prefix = await runSupabase(["__complete", "start"], {
          cwd: project.dir,
          home: home.dir,
          env: {
            SUPABASE_EXPERIMENTAL_STACK: undefined,
            SUPABASE_WORKDIR: undefined,
          },
        });
        expect(prefix.exitCode).toBe(0);
        expect(prefix.stdout).toContain("start");
        expect(prefix.stderr).toBe("");

        const fallback = await runSupabase(["__complete", "--output-format=json", "start", "--"], {
          cwd: project.dir,
          home: home.dir,
          env: {
            SUPABASE_EXPERIMENTAL_STACK: undefined,
            SUPABASE_WORKDIR: undefined,
          },
        });
        expect(fallback.exitCode).toBe(0);
        expect(fallback.stdout).toContain("--ignore-health-check");
        expect(fallback.stderr).toBe("");

        const help = await runSupabase(["start", "--help"], {
          cwd: project.dir,
          home: home.dir,
          env: {
            SUPABASE_EXPERIMENTAL_STACK: undefined,
            SUPABASE_WORKDIR: undefined,
          },
        });
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain("--ignore-health-check");
        expect(help.stderr).toBe("");

        const completionFailure = await runSupabase(
          ["__complete", "--output-format=json", "start", "--"],
          {
            cwd: project.dir,
            home: home.dir,
            env: {
              SUPABASE_EXPERIMENTAL_STACK: "invalid",
              SUPABASE_WORKDIR: undefined,
            },
          },
        );
        expect(completionFailure.exitCode).toBe(1);
        expect(completionFailure.stdout).toBe("");
        expect(completionFailure.stderr).toContain("must be 0 or 1");

        const invalidEnv = await runSupabase(["start", "--output-format=json"], {
          cwd: project.dir,
          home: home.dir,
          env: {
            SUPABASE_EXPERIMENTAL_STACK: "invalid",
            SUPABASE_WORKDIR: undefined,
          },
        });
        expect(invalidEnv.exitCode).toBe(1);
        expect(invalidEnv.stderr).toBe("");
        expect(JSON.parse(invalidEnv.stdout)).toMatchObject({
          _tag: "Error",
          error: { code: "StackRoutingError" },
        });
      } finally {
        await project.cleanup();
        home[Symbol.dispose]();
      }
    },
  );
});
