import { beforeAll, describe, expect, test } from "vitest";
import { prefetch } from "@supabase/stack/bun";
import { makeTempHome, runSupabase } from "../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await prefetch();
});

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
        expect(stdout).toContain("Starting local Supabase stack...");
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
