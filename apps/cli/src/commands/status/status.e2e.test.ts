import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../tests/helpers/cli.ts";

const STATUS_TIMEOUT_MS = 90_000;

describe("supabase status", () => {
  test(
    "shows connection info and service states for the current project",
    { timeout: STATUS_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();

      try {
        const startResult = await runSupabase(["start", "--detach"], { home: home.dir });
        expect(startResult.exitCode).toBe(0);

        const result = await runSupabase(["status"], { home: home.dir });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Show local Supabase stack status");
        expect(result.stdout).toContain("Local Supabase stack is running.");
        expect(result.stdout).toContain("API URL:");
        expect(result.stdout).toContain("DB URL:");
        expect(result.stdout).toContain("Publishable key:");
        expect(result.stdout).toContain("Secret key:");
        expect(result.stdout).toContain("auth:");
        expect(result.stdout).toContain("postgres:");
        expect(result.stdout).not.toContain("Stack status");
        expect(result.stdout).not.toContain("(running) -");
      } finally {
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );

  test(
    "emits a single structured snapshot in json mode",
    { timeout: STATUS_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();

      try {
        const startResult = await runSupabase(["start", "--detach"], { home: home.dir });
        expect(startResult.exitCode).toBe(0);

        const result = await runSupabase(["status", "--output-format", "json"], {
          home: home.dir,
        });

        expect(result.exitCode).toBe(0);
        const body = JSON.parse(result.stdout) as {
          readonly message: string;
          readonly running: boolean;
          readonly api_url: string;
          readonly db_url: string;
          readonly publishable_key: string;
          readonly secret_key: string;
          readonly services: ReadonlyArray<{ readonly name: string; readonly status: string }>;
        };

        expect(body.message).toBe("Local Supabase stack is running.");
        expect(body.running).toBe(true);
        expect(body.api_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(body.db_url).toMatch(
          /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/,
        );
        expect(body.publishable_key).toBeTruthy();
        expect(body.secret_key).toBeTruthy();
        expect(body.services).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "auth" }),
            expect.objectContaining({ name: "postgres" }),
          ]),
        );
      } finally {
        await runSupabase(["stop"], { home: home.dir }).catch(() => {});
        home[Symbol.dispose]();
      }
    },
  );
});
