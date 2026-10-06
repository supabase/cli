import { describe, expect, test } from "vitest";
import { runSupabase, stripAnsi } from "../../tests/helpers/cli.ts";

function parseJsonLines(output: string): Array<unknown> {
  return stripAnsi(output)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("CLI agent output", () => {
  test("formats parse errors as JSON for detected coding agents", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["definitely-not-a-command"], {
      env: { CODEX_SANDBOX: "1" },
    });

    expect(exitCode).toBe(1);
    // stdout carries exactly one JSON error line; the library's help doc goes to stderr.
    expect(parseJsonLines(stdout)).toEqual([
      expect.objectContaining({
        _tag: "Error",
        error: expect.objectContaining({ code: "UnknownSubcommand" }),
      }),
    ]);
    expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
  });

  test.each([
    { stack: "1", envelope: { type: "error" } },
    { stack: "0", envelope: { _tag: "Error" } },
  ])(
    "formats functions serve parse errors for the selected backend (stack=$stack)",
    async ({ stack, envelope }) => {
      const { exitCode, stdout, stderr } = await runSupabase(["functions", "serve", "--bogus"], {
        env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: stack },
      });

      expect(exitCode).toBe(1);
      expect(parseJsonLines(stdout)).toEqual([
        expect.objectContaining({
          ...envelope,
          error: expect.objectContaining({
            code: "UnrecognizedOption",
            message: expect.stringContaining("--bogus"),
          }),
        }),
      ]);
      expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
    },
  );

  test("keeps legacy functions serve handler errors in JSON for detected coding agents", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["functions", "serve", "--inspect-main"],
      {
        env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "0" },
      },
    );

    expect(exitCode).toBe(1);
    expect(parseJsonLines(stdout)).toEqual([
      expect.objectContaining({
        _tag: "Error",
        error: expect.objectContaining({
          message: expect.stringContaining("--inspect-main must be used together"),
        }),
      }),
    ]);
    expect(stderr).toBe("");
  });

  test("defaults functions serve to stream-json for detected coding agents", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["functions", "serve"], {
      env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "1" },
    });
    const explicitJson = await runSupabase(["functions", "serve", "--output-format", "json"], {
      env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "1" },
    });

    expect(exitCode).toBe(1);
    expect(parseJsonLines(stdout)).toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "FunctionsServeStackError",
          message: "The local stack is not running.",
        }),
      }),
    ]);
    expect(stderr).toBe("");
    expect(explicitJson.exitCode).toBe(1);
    expect(parseJsonLines(explicitJson.stdout)).toEqual([
      expect.objectContaining({
        _tag: "Error",
        error: expect.objectContaining({
          code: "FunctionsServeStackError",
          message: "Functions serve requires text or stream-json output.",
        }),
      }),
    ]);
    expect(explicitJson.stderr).toBe("");
  });

  test("keeps parse errors in text mode when --output-format=text is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--output-format", "text", "definitely-not-a-command"],
      {
        env: { CODEX_SANDBOX: "1" },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("DESCRIPTION");
    expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
  });

  test("keeps parse errors in text mode when --agent=no is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--agent", "no", "definitely-not-a-command"],
      {
        env: { CODEX_SANDBOX: "1" },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("DESCRIPTION");
    expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
  });

  test("formats parse errors as JSON when --agent=yes is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--agent", "yes", "definitely-not-a-command"],
      {
        env: {},
      },
    );

    expect(exitCode).toBe(1);
    expect(parseJsonLines(stdout)).toEqual([
      expect.objectContaining({
        _tag: "Error",
        error: expect.objectContaining({ code: "UnknownSubcommand" }),
      }),
    ]);
    expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
  });

  test("keeps built-in version and help in text mode for detected coding agents", async () => {
    const version = await runSupabase(["--version"], {
      env: { CODEX_SANDBOX: "1" },
    });
    const help = await runSupabase(["--help"], {
      env: { CODEX_SANDBOX: "1" },
    });

    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => JSON.parse(version.stdout)).toThrow();
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("DESCRIPTION");
    expect(() => JSON.parse(help.stdout)).toThrow();
  });
});
