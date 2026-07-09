import { describe, expect, test } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit, Layer } from "effect";
import { CliOutput, Command, Flag } from "effect/unstable/cli";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";
import { exitCodeForFailure, withoutParseErrorHelpDump } from "./run.ts";

/**
 * A `Console.Console` test double that records `log`/`error` calls into
 * `calls` instead of writing anywhere, for asserting on writes through the
 * `Console.Console` Effect service directly. Deliberately NOT `vi.spyOn`ing
 * the global `console` object: under this repo's Bun + Vitest combination,
 * spying on `console.log` and `console.error` in the SAME test reliably
 * breaks call detection on both (reproduced in isolation, unrelated to this
 * fix) — observing the `Console.Console` service `withoutParseErrorHelpDump`
 * itself reads and overrides is both more precise and immune to that quirk.
 */
function fakeConsole(): { readonly console: Console.Console; readonly calls: Array<string> } {
  const calls: Array<string> = [];
  const unused = () => {};
  return {
    calls,
    console: {
      assert: unused,
      clear: unused,
      count: unused,
      countReset: unused,
      debug: unused,
      dir: unused,
      dirxml: unused,
      error: (...args: ReadonlyArray<unknown>) => {
        calls.push(`error:${args.join(" ")}`);
      },
      group: unused,
      groupCollapsed: unused,
      groupEnd: unused,
      info: unused,
      log: (...args: ReadonlyArray<unknown>) => {
        calls.push(`log:${args.join(" ")}`);
      },
      table: unused,
      time: unused,
      timeEnd: unused,
      timeLog: unused,
      trace: unused,
      warn: unused,
    },
  };
}

/**
 * CLI-1906: `supabase branches` (a legacy "group" command — subcommands, no
 * runnable handler of its own) used to exit 1 when invoked bare, even though
 * the printed help was identical to `supabase branches --help`, which already
 * exited 0. These tests run the real `legacyBranchesCommand` definition
 * through `Command.runWith` (same technique as `version.integration.test.ts`)
 * so the `ShowHelp` cause shape is the one the real CLI actually produces, not
 * a hand-rolled stand-in. `legacyBranchesCommand` is exercised directly
 * (rather than nested under `legacyRoot`) because `legacyRoot`'s
 * `Command.provide` (see `Command.ts`'s `provide`/`withSubcommands`) wraps its
 * *entire* handle — including the bare/`--help`/parse-error paths exercised
 * here — in the production output/proxy layer graph (`Layer.unwrap` reading
 * every global flag, resolving the Go proxy binary, etc). `Effect.provide`
 * still *builds* that layer graph before running the wrapped handle even on
 * these runs; it just never gets *consumed*, because the `ShowHelp` failure
 * fires before any leaf subcommand handler body executes. Exercising
 * `legacyBranchesCommand` directly avoids needing to provide or mock that
 * unused graph for a test that only cares about the `ShowHelp` cause shape.
 */
describe("legacy group command exit codes (CLI-1906)", () => {
  const layerFor = (args: ReadonlyArray<string>) =>
    Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args }),
      BunServices.layer,
    );

  const runBranches = (args: ReadonlyArray<string>) =>
    Effect.runPromiseExit(
      Command.runWith(legacyBranchesCommand, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(layerFor(args)),
      ),
    );

  test("bare `branches` (no subcommand, no --help) fails with a clean ShowHelp that maps to exit 0", async () => {
    const exit = await runBranches([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;

    expect(exitCodeForFailure(exit.cause)).toBe(0);
  });

  test("`branches --help` succeeds outright and exits 0", async () => {
    const exit = await runBranches(["--help"]);
    // The `--help` global flag is handled as a successful `GlobalFlag.Action`, so this
    // never even reaches the ShowHelp-as-failure path bare `branches` goes through above.
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("`branches` with an unrecognized flag is a genuine parse error that still exits 1", async () => {
    const exit = await runBranches(["--this-flag-does-not-exist"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;

    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });
});

/**
 * CLI-1901: a required-flag/choice parse failure used to dump the full help
 * doc to stdout (`console.log`) AND print the error twice — once from the
 * vendored `effect` CLI library's own `showHelp()` (`console.error`), once
 * from this repo's own Go-parity renderer (`handledProgram` +
 * `normalizeCause` in `run.ts`, exercised downstream of this test, not
 * here). These tests run real commands through `Command.runWith`, wrapped in
 * `withoutParseErrorHelpDump`, and assert on the calls recorded by a fake
 * `Console.Console` (see `fakeConsole` above) provided in place of the real
 * one — that's the exact service `withoutParseErrorHelpDump` overrides and
 * later replays through, so it's what actually matters here.
 *
 * `legacyBranchesCommand` (no `Command.provide` of its own — see the
 * sibling CLI-1906 suite above for why that matters) covers the
 * `UnrecognizedOption` shape and proves the buffering/conditional-flush
 * wiring end to end. `MissingOption`/`InvalidValue` specifically need a
 * genuinely required flag / `Flag.choice`, which every shipped native
 * command with one (e.g. `sso add`'s `--type`, see `add.command.ts`) also
 * wraps in its own `Command.provide`d management-API runtime layer —
 * exercising those tags against a real shipped command would mean
 * providing or mocking that whole layer graph for services this parse-error
 * path never consumes (same friction the CLI-1906 suite's own comment
 * describes and avoids). A minimal `Command.make` with a required
 * `Flag.string`/`Flag.choice` still runs through the exact same vendored
 * `Command.runWith`/`showHelp()` machinery that produces the bug — the
 * command is synthetic, but the `ShowHelp` cause shape it produces is not; a
 * real subprocess run against `sso add` itself (the issue's own named
 * repro target) is covered end to end by `sso.e2e.test.ts`.
 */
describe("withoutParseErrorHelpDump (CLI-1901)", () => {
  const layerFor = (args: ReadonlyArray<string>, console: Console.Console) =>
    Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args }),
      Layer.succeed(Console.Console, console),
      BunServices.layer,
    );

  const runBranches = (args: ReadonlyArray<string>, console: Console.Console) =>
    withoutParseErrorHelpDump(
      Command.runWith(legacyBranchesCommand, { version: "0.0.0-test" })(args),
    ).pipe(Effect.provide(layerFor(args, console)));

  const requiredFlagCommand = Command.make("test-required-flag", {
    type: Flag.choice("type", ["saml"] as const),
  });

  const runRequiredFlagCommand = (args: ReadonlyArray<string>, console: Console.Console) =>
    withoutParseErrorHelpDump(
      Command.runWith(requiredFlagCommand, { version: "0.0.0-test" })(args),
    ).pipe(Effect.provide(layerFor(args, console)));

  test("an unrecognized flag: suppresses the help dump and the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runBranches(["--this-flag-does-not-exist"], console));

    // The vendored library's own showHelp() writes are gone entirely — no
    // stdout help dump, no duplicate stderr error.
    expect(calls).toEqual([]);

    // The original ShowHelp/UnrecognizedOption failure still propagates —
    // the fix only suppresses the library's own console writes, it must not
    // swallow or reshape the failure this repo's own `handledProgram` +
    // `normalizeCause` still needs to render the single Go-parity line.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("`branches` bare (clean ShowHelp) still flushes its help dump and exits 0 (untouched)", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runBranches([], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("log:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(0);
  });

  test("missing a required flag: suppresses the help dump and the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand([], console));

    expect(calls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("an invalid Flag.choice value: suppresses the help dump and the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--type", "bogus"], console));

    expect(calls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("`--help` on a command with a required flag still prints the full help doc and exits 0 (untouched)", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--help"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
