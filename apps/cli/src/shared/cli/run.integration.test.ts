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
 * Go only suppresses its own usage block for a MISSING REQUIRED FLAG
 * (`ValidateRequiredFlags`, post-`PersistentPreRunE`) — verified against the
 * real `apps/cli-go/supabase-go` binary. Every other parse-error tag
 * (`UnrecognizedOption`, `InvalidValue`, `MissingArgument`,
 * `UnknownSubcommand`) is raised during `ParseFlags`/`ValidateArgs`, BEFORE
 * `PersistentPreRunE` sets `SilenceUsage` — Go still shows a usage block for
 * those, always on stderr, never stdout. `classifyParseErrorConsoleOutput`
 * (see `run.ts`) mirrors that split; these tests cover both branches.
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
      { rootCommand: legacyBranchesCommand, args },
    ).pipe(Effect.provide(layerFor(args, console)));

  // `type`'s `-t` alias mirrors the real `sso add --type`/`-t` flag
  // (`add.command.ts`) so the short-alias "present but missing its value"
  // case below (Codex review finding, CLI-1901 follow-up) exercises the same
  // shape end to end, without pulling in `sso add`'s own management-API
  // runtime layer graph (see the suite-level comment above for why that's
  // avoided here).
  const requiredFlagCommand = Command.make("test-required-flag", {
    type: Flag.choice("type", ["saml"] as const).pipe(Flag.withAlias("t")),
  });

  const runRequiredFlagCommand = (args: ReadonlyArray<string>, console: Console.Console) =>
    withoutParseErrorHelpDump(
      Command.runWith(requiredFlagCommand, { version: "0.0.0-test" })(args),
      { rootCommand: requiredFlagCommand, args },
    ).pipe(Effect.provide(layerFor(args, console)));

  test("an unrecognized flag: replays the help dump to stderr (never stdout) and drops the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runBranches(["--this-flag-does-not-exist"], console));

    // The library's own duplicate `Console.error` write is gone. Its help
    // doc survives, but redirected to stderr (`error:`), never stdout
    // (`log:`) — matching Go, which still shows usage for an unrecognized
    // flag (raised during `ParseFlags`, before `SilenceUsage` is set), just
    // on stderr.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);

    // The original ShowHelp/UnrecognizedOption failure still propagates —
    // the fix only suppresses the library's own console writes, it must not
    // swallow or reshape the failure this repo's own `handledProgram` +
    // `normalizeCause` still needs to render the single Go-parity line.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("`branches` bare (clean ShowHelp) still flushes its help dump to stdout and exits 0 (untouched)", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runBranches([], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("log:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(0);
  });

  test("missing a required flag: drops the help dump entirely and the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand([], console));

    // Go's `SilenceUsage` is already active for a missing required flag
    // (post-`PersistentPreRunE`) — nothing survives, not even on stderr.
    expect(calls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  // CLI-1901 (Codex review finding): the vendored library can't tell "flag
  // never given" apart from "flag given with no value following it" — both
  // raise `MissingOption`. Go's pflag DOES distinguish these (a present-but-
  // valueless flag is a `ParseFlags`-time error, before `SilenceUsage` is
  // set) — verified against the real `apps/cli-go/supabase-go` binary, which
  // still prints its usage block for this input. `--type` as the LAST token
  // (no value token follows it) reproduces that "present but valueless" case.
  test("a required flag present on argv but missing its value: replays the help dump to stderr instead of dropping it", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--type"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  // Codex review finding (CLI-1901 follow-up): the same "present but missing
  // its value" case, but supplied via the flag's SHORT ALIAS (`-t`) instead of
  // its canonical long form. Go's pflag treats a present-but-valueless
  // shorthand exactly like the long form (`parseSingleShortArg` raises the
  // same `ValueRequiredError` as `parseLongArg`, same pre-`SilenceUsage`
  // timing) — verified against the real `apps/cli-go/supabase-go` binary
  // (`sso add -t`: full usage block on stderr, byte-parallel to `sso add
  // --type`). Before this fix, `isMissingFlagTokenPresent` only recognized
  // the canonical `--type` token and misclassified `-t` as absent, silently
  // dropping the help dump instead.
  test("a required flag present on argv by its short alias but missing its value: replays the help dump to stderr instead of dropping it", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["-t"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("an invalid Flag.choice value: replays the help dump to stderr (never stdout) and drops the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--type", "bogus"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("`--help` on a command with a required flag still prints the full help doc to stdout and exits 0 (untouched)", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--help"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("log:"))).toBe(true);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // Effect's default logger (`Effect.log*`) resolves through this same
  // `Console.Console` reference (`Logger.withConsoleLog`/`withConsoleError`
  // in the vendored library) — see the "buffering scope" note on
  // `withoutParseErrorHelpDump` in `run.ts`. No command handler in this
  // codebase uses `Effect.log*` today, but this pins the invariant the doc
  // comment describes: on a successful run, buffered logger output still
  // reaches the user (deferred to end-of-run, not dropped).
  test("Effect.log* output during a successful run is still flushed, not lost", async () => {
    const { console, calls } = fakeConsole();
    const program = Effect.gen(function* () {
      yield* Effect.logInfo("hello from a handler");
      return "done" as const;
    });

    const result = await Effect.runPromise(
      withoutParseErrorHelpDump(program, { rootCommand: requiredFlagCommand, args: [] }).pipe(
        Effect.provide(Layer.succeed(Console.Console, console)),
      ),
    );

    expect(result).toBe("done");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.includes("hello from a handler"))).toBe(true);
  });
});
