import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

function parseJsonLines(output: string): Array<unknown> {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("legacy CLI agent output", () => {
  test("formats parse errors as JSON for detected coding agents", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["definitely-not-a-command"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    });

    expect(exitCode).toBe(1);
    expect(parseJsonLines(stdout)).toEqual([
      expect.objectContaining({ _tag: "Help" }),
      expect.objectContaining({
        _tag: "Error",
        error: expect.objectContaining({ code: "ShowHelp" }),
      }),
    ]);
    expect(parseJsonLines(stderr)).toEqual([
      expect.objectContaining({
        _tag: "Errors",
        errors: [expect.objectContaining({ code: "UnknownSubcommand" })],
      }),
    ]);
  });

  test("keeps parse errors in text mode when --agent=no is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--agent", "no", "definitely-not-a-command"],
      {
        entrypoint: "legacy",
        env: { CODEX_SANDBOX: "1" },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain("DESCRIPTION");
    expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
  });
});
