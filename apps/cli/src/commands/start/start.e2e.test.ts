import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 60_000;

describe("supabase start", () => {
  test(
    "starts in detached mode and prints connection info",
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();

      try {
        const { stdout, exitCode } = await runSupabase(["start", "--detach"], { home: home.dir });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Local Supabase started");
        expect(stdout).toContain("API URL:");
        expect(stdout).toContain("DB URL:");
      } finally {
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test(
    "shows the intro and normalized error when detached start is already running",
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();

      try {
        const first = await runSupabase(["start", "--detach"], { home: home.dir });
        expect(first.exitCode).toBe(0);

        const second = await runSupabase(["start", "--detach"], { home: home.dir });
        const output = `${second.stdout}${second.stderr}`;

        expect(second.exitCode).toBe(1);
        expect(output).toContain("Start local Supabase stack");
        expect(output).toContain('A Supabase stack "cli" is already running');
        expect(output).not.toContain('Use "supabase stop" first.');
        expect(output).toContain(
          "Use `supabase stop` before starting another stack for this project.",
        );
      } finally {
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test(
    "starts in foreground mode and streams startup output",
    { timeout: START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();

      try {
        const { stdout, exitCode } = await runSupabase(["start"], {
          home: home.dir,
          until: /API URL:/,
          untilTimeoutMs: START_TIMEOUT_MS,
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Start local Supabase stack");
        expect(stdout).toContain("Local Supabase started");
        expect(stdout).toContain("API URL:");
      } finally {
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test("shows help text with start flags", async () => {
    const { stdout, exitCode } = await runSupabase(["start", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Start the local Supabase development stack.");
    expect(stdout).toContain("--detach");
    expect(stdout).toContain("--exclude");
  });
});
