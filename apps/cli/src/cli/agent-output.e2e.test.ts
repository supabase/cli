import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect, stripAnsi } from "../../tests/helpers/cli.ts";

function parseJsonLines(output: string): Array<unknown> {
  return stripAnsi(output)
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("CLI agent output", () => {
  it.live("formats parse errors as JSON for detected coding agents", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["definitely-not-a-command"], {
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
    }),
  );

  it.live(
    "formats Stack functions serve parse errors as stream-json for detected coding agents",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["functions", "serve", "--bogus"],
          {
            env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "1" },
          },
        );

        expect(exitCode).toBe(1);
        expect(parseJsonLines(stdout)).toEqual([
          expect.objectContaining({
            type: "error",
            error: expect.objectContaining({
              code: "UnrecognizedOption",
              message: expect.stringContaining("--bogus"),
            }),
          }),
        ]);
        expect(parseJsonLines(stderr)).toEqual([expect.objectContaining({ _tag: "Help" })]);
      }),
  );

  it.live("keeps legacy functions serve handler errors in JSON for detected coding agents", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
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
    }),
  );

  it.live("defaults functions serve to stream-json for detected coding agents", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["functions", "serve"], {
        env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "1" },
      });
      const explicitJson = yield* runSupabaseEffect(
        ["functions", "serve", "--output-format", "json"],
        {
          env: { CODEX_SANDBOX: "1", SUPABASE_EXPERIMENTAL_STACK: "1" },
        },
      );

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
    }),
  );

  it.live("keeps parse errors in text mode when --output-format=text is explicit", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
        ["--output-format", "text", "definitely-not-a-command"],
        {
          env: { CODEX_SANDBOX: "1" },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("DESCRIPTION");
      expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
    }),
  );

  it.live("keeps parse errors in text mode when --agent=no is explicit", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
        ["--agent", "no", "definitely-not-a-command"],
        {
          env: { CODEX_SANDBOX: "1" },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("DESCRIPTION");
      expect(stderr).toContain('Unknown subcommand "definitely-not-a-command"');
    }),
  );

  it.live("formats parse errors as JSON when --agent=yes is explicit", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
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
    }),
  );

  it.live("keeps built-in version and help in text mode for detected coding agents", () =>
    Effect.gen(function* () {
      const version = yield* runSupabaseEffect(["--version"], {
        env: { CODEX_SANDBOX: "1" },
      });
      const help = yield* runSupabaseEffect(["--help"], {
        env: { CODEX_SANDBOX: "1" },
      });

      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(() => JSON.parse(version.stdout)).toThrow();
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("DESCRIPTION");
      expect(() => JSON.parse(help.stdout)).toThrow();
    }),
  );
});
