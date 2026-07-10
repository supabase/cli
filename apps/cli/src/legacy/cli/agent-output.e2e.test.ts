import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

function stripAnsi(output: string): string {
  let stripped = "";
  for (let i = 0; i < output.length; i++) {
    const charCode = output.charCodeAt(i);
    if (charCode !== 0x1b || output[i + 1] !== "[") {
      stripped += output[i];
      continue;
    }

    i += 2;
    while (i < output.length) {
      const code = output.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
      i++;
    }
  }
  return stripped;
}

function parseJsonLines(output: string): Array<unknown> {
  return stripAnsi(output)
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
  });

  test("keeps parse errors in text mode when --output-format=text is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--output-format", "text", "definitely-not-a-command"],
      {
        entrypoint: "legacy",
        env: { CODEX_SANDBOX: "1" },
      },
    );

    expect(exitCode).toBe(1);
    // CLI-1901: the help doc no longer prints to stdout at all.
    expect(stdout).toBe("");
    expect(stderr).toContain("DESCRIPTION");
    expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
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
    expect(stdout).toBe("");
    expect(stderr).toContain("DESCRIPTION");
    expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
  });

  test("formats parse errors as JSON when --agent=yes is explicit", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["--agent", "yes", "definitely-not-a-command"],
      {
        entrypoint: "legacy",
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
      entrypoint: "legacy",
      env: { CODEX_SANDBOX: "1" },
    });
    const help = await runSupabase(["--help"], {
      entrypoint: "legacy",
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
