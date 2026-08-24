import { describe, expect, test } from "vitest";
import { runSupabase, stripAnsi } from "../../../tests/helpers/cli.ts";

function parseJsonLines(output: string): Array<unknown> {
  return stripAnsi(output)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("legacy CLI agent output", () => {
  test("formats parse errors as JSON for detected coding agents", () =>
    runSupabase(["definitely-not-a-command"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      // CLI-1901: the vendored effect CLI library's own duplicate JSON render
      // (the old `{_tag:"Help"}` + `{_tag:"Error", error:{code:"ShowHelp"}}`
      // pair on stdout, `{_tag:"Errors"}` on stderr) is gone. stdout carries
      // exactly this repo's single Go-parity error line; the library's help
      // doc is redirected to stderr instead of being dropped or duplicated.
      expect(parseJsonLines(stdout)).toEqual([
        expect.objectContaining({
          _tag: "Error",
          error: expect.objectContaining({ code: "UnknownSubcommand" }),
        }),
      ]);
      expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
    }));

  test("keeps parse errors in text mode when --output-format=text is explicit", () =>
    runSupabase(["--output-format", "text", "definitely-not-a-command"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      // CLI-1901: the help doc no longer prints to stdout at all.
      expect(stdout).toBe("");
      expect(stderr).toContain("DESCRIPTION");
      expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
    }));

  test("keeps parse errors in text mode when --agent=no is explicit", () =>
    runSupabase(["--agent", "no", "definitely-not-a-command"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("DESCRIPTION");
      expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
    }));

  test("formats parse errors as JSON when --agent=yes is explicit", () =>
    runSupabase(["--agent", "yes", "definitely-not-a-command"], {
      entrypoint: "legacy",
      env: {},
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(parseJsonLines(stdout)).toEqual([
        expect.objectContaining({
          _tag: "Error",
          error: expect.objectContaining({ code: "UnknownSubcommand" }),
        }),
      ]);
      expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
    }));

  test("keeps built-in version and help in text mode for detected coding agents", () => {
    const version = runSupabase(["--version"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    });
    const help = runSupabase(["--help"], {
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    });
    return Promise.all([version, help]).then(([versionResult, helpResult]) => {
      expect(versionResult.exitCode).toBe(0);
      expect(versionResult.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(() => JSON.parse(versionResult.stdout)).toThrow();
      expect(helpResult.exitCode).toBe(0);
      expect(helpResult.stdout).toContain("DESCRIPTION");
      expect(() => JSON.parse(helpResult.stdout)).toThrow();
    });
  });
});
