import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Config, Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../../tests/helpers/ansi.ts";
import { runSupabaseEffect } from "../../tests/helpers/cli.ts";

const binary = fileURLToPath(new URL("../../dist/supabase", import.meta.url));
const reminder = "⚠ Secure your account";

function runWithTerminal(args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-account-reminder-" });
    const path = yield* Config.String("PATH").pipe(Config.withDefault(""));
    return yield* spawner.string(
      ChildProcess.make("script", ["-q", "/dev/null", binary, ...args], {
        stdin: "ignore",
        env: {
          PATH: path,
          HOME: home,
          SUPABASE_HOME: home,
          SUPABASE_NO_UPDATE_NOTIFIER: "1",
          SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "exhausted",
          TERM: "xterm",
          ...extraEnv,
        },
      }),
    );
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"), Effect.provide(BunServices.layer));
}

describe("mock account recovery reminder", () => {
  it.live.skipIf(process.platform !== "darwin")(
    "shows the mock after an interactive command and suppresses help, machine output, agents, and CI",
    () =>
      Effect.gen(function* () {
        const regular = stripAnsi(yield* runWithTerminal(["telemetry", "status"]));
        expect(regular).toContain("Telemetry is");
        expect(regular.split(reminder)).toHaveLength(2);
        expect(regular).toContain("https://supabase.com/dashboard/account/security");
        expect(
          stripAnsi(
            yield* runWithTerminal(["telemetry", "status"], {
              SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "missing",
            }),
          ),
        ).toContain("You have no recovery codes");
        expect(
          stripAnsi(
            yield* runWithTerminal(["telemetry", "status"], {
              SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "low",
            }),
          ),
        ).toContain("You have few recovery codes left");

        for (const args of [
          ["telemetry", "status", "--help"],
          ["telemetry", "status", "--output-format=json"],
          ["telemetry", "status", "--agent=yes", "--output-format=text"],
        ]) {
          const output = yield* runWithTerminal(args);
          expect(output).toMatch(/Telemetry is|USAGE/);
          expect(output).not.toContain(reminder);
        }
        const ci = yield* runWithTerminal(["telemetry", "status"], { CI: "1" });
        expect(ci).toContain("Telemetry is");
        expect(ci).not.toContain(reminder);

        const failed = yield* runWithTerminal(["telemetry", "status", "--unknown-flag"]);
        expect(failed).toContain("Unrecognized flag: --unknown-flag");
        expect(failed).not.toContain(reminder);

        const forcedColor = yield* runWithTerminal(["telemetry", "status"], {
          CLICOLOR_FORCE: "1",
        });
        expect(forcedColor).toContain("\u001B[31m⚠ Secure your account\u001B[39m");
        expect(forcedColor).toContain("\u001B[31m│\u001B[39m Your recovery codes are exhausted.");

        for (const state of ["missing", "low"] as const) {
          const warning = yield* runWithTerminal(["telemetry", "status"], {
            CLICOLOR_FORCE: "1",
            SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: state,
          });
          expect(warning).toContain("\u001B[33m⚠ Secure your account\u001B[39m");
          expect(warning).toContain("\u001B[33m│\u001B[39m");
        }
      }),
  );

  it.live("keeps piped command output free of the reminder", () =>
    Effect.gen(function* () {
      const piped = yield* runSupabaseEffect(["telemetry", "status"], {
        env: { SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "missing" },
      });
      expect(piped.exitCode).toBe(0);
      expect(piped.stdout).toContain("Telemetry is");
      expect(piped.stderr).not.toContain(reminder);
    }),
  );
});
