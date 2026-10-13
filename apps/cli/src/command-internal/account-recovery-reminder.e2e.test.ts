import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { stripAnsi } from "../../tests/helpers/ansi.ts";
import { runSupabase } from "../../tests/helpers/cli.ts";

const binary = fileURLToPath(new URL("../../dist/supabase", import.meta.url));
const reminder = "⚠ Secure your account";

function runWithTerminal(args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "supabase-account-reminder-"));
  try {
    const result = spawnSync("script", ["-q", "/dev/null", binary, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        SUPABASE_HOME: home,
        SUPABASE_NO_UPDATE_NOTIFIER: "1",
        SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "exhausted",
        TERM: "xterm",
        ...extraEnv,
      },
    });
    if (result.error) throw result.error;
    return result.stdout;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("mock account recovery reminder", () => {
  test.skipIf(process.platform !== "darwin")(
    "shows the mock after an interactive command and suppresses help, machine output, agents, and CI",
    () => {
      const regular = stripAnsi(runWithTerminal(["telemetry", "status"]));
      expect(regular).toContain("Telemetry is");
      expect(regular.split(reminder)).toHaveLength(2);
      expect(regular).toContain("https://supabase.com/dashboard/account/security");
      expect(
        stripAnsi(runWithTerminal(["telemetry", "status"], {
          SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "missing",
        })),
      ).toContain("You have no recovery codes");
      expect(
        stripAnsi(runWithTerminal(["telemetry", "status"], {
          SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "low",
        })),
      ).toContain("You have few recovery codes left");

      for (const args of [
        ["telemetry", "status", "--help"],
        ["telemetry", "status", "--output-format=json"],
        ["telemetry", "status", "--agent=yes", "--output-format=text"],
      ]) {
        const output = runWithTerminal(args);
        expect(output).toMatch(/Telemetry is|USAGE/);
        expect(output).not.toContain(reminder);
      }
      const ci = runWithTerminal(["telemetry", "status"], { CI: "1" });
      expect(ci).toContain("Telemetry is");
      expect(ci).not.toContain(reminder);

      const failed = runWithTerminal(["telemetry", "status", "--unknown-flag"]);
      expect(failed).toContain("Unrecognized flag: --unknown-flag");
      expect(failed).not.toContain(reminder);

      const forcedColor = runWithTerminal(["telemetry", "status"], { CLICOLOR_FORCE: "1" });
      expect(forcedColor).toContain("\u001B[31m⚠ Secure your account\u001B[39m");
    },
  );

  test("keeps piped command output free of the reminder", async () => {
    const piped = await runSupabase(["telemetry", "status"], {
      env: { SUPABASE_ACCOUNT_RECOVERY_REMINDER_MOCK: "missing" },
    });
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toContain("Telemetry is");
    expect(piped.stderr).not.toContain(reminder);
  });
});
