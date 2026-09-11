import { describe, expect, test } from "@effect/vitest";
import { Console, Effect, Exit, Layer } from "effect";
import { Argument, CliOutput, Command, Flag } from "effect/unstable/cli";
import { branchesCommand } from "../../commands/branches/branches.command.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { emptyEnv, mockOutput } from "../../../tests/helpers/mocks.ts";
import { CliArgs } from "./cli-args.service.ts";
import { OutputFormatFlag } from "./global-flags.ts";
import { exitCodeForFailure, withoutParseErrorHelpDump } from "./run.ts";

const testBranchesCommand = branchesCommand.pipe(
  Command.withGlobalFlags([OutputFormatFlag, ...GLOBAL_FLAGS]),
);

/**
 * A `Console.Console` test double that records `log`/`error` calls into `calls` instead of
 * writing anywhere. Not `vi.spyOn`-based: spying on `console.log` and `console.error` in the same
 * test unreliably breaks call detection under this repo's Bun + Vitest combination.
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
 * Runs the real `branchesCommand` definition directly (not nested under `rootCommand`) through
 * `Command.runWith`, so the `ShowHelp` cause shape is the one the real CLI produces. Bypassing
 * `rootCommand` avoids needing to provide or mock its full production layer graph, since the
 * `ShowHelp` failure these tests care about fires before any leaf handler body runs.
 */
describe("group command exit codes (CLI-1906)", () => {
  const layerFor = (args: ReadonlyArray<string>) =>
    Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args }),
      mockOutput({ format: "text" }).layer,
      emptyEnv(),
    );

  const runBranches = (args: ReadonlyArray<string>) =>
    Effect.runPromiseExit(
      Command.runWith(testBranchesCommand, { version: "0.0.0-test" })(args).pipe(
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
 * Runs commands through `Command.runWith`, wrapped in `withoutParseErrorHelpDump`, and asserts on
 * the calls recorded by a fake `Console.Console` (see `fakeConsole` above) substituted for the
 * real one — the exact service `withoutParseErrorHelpDump` overrides and replays through.
 *
 * `branchesCommand` covers the `UnrecognizedOption` shape end to end. `MissingOption`/
 * `InvalidValue` need a genuinely required flag or `Flag.Literals`, which every shipped command
 * with one also wraps in its own management-API runtime layer — a minimal synthetic
 * `Command.make` runs through the same `Command.runWith`/`showHelp()` machinery without that
 * overhead. A real subprocess run against `sso add` is covered end to end by `sso.e2e.test.ts`.
 */
describe("withoutParseErrorHelpDump (CLI-1901)", () => {
  const layerFor = (args: ReadonlyArray<string>, console: Console.Console) =>
    Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args }),
      Layer.succeed(Console.Console, console),
      mockOutput({ format: "text" }).layer,
      emptyEnv(),
    );

  const runBranches = (args: ReadonlyArray<string>, console: Console.Console) =>
    withoutParseErrorHelpDump(
      Command.runWith(testBranchesCommand, { version: "0.0.0-test" })(args),
      { rootCommand: testBranchesCommand, args },
    ).pipe(Effect.provide(layerFor(args, console)));

  // `type`'s `-t` alias mirrors the real `sso add --type`/`-t` flag, so the short-alias case
  // below exercises the same shape without pulling in a management-API runtime layer.
  const requiredFlagCommand = Command.make("test-required-flag", {
    type: Flag.Literals("type", ["saml"] as const).pipe(Flag.withAlias("t")),
  });

  const runRequiredFlagCommand = (args: ReadonlyArray<string>, console: Console.Console) =>
    withoutParseErrorHelpDump(
      Command.runWith(requiredFlagCommand, { version: "0.0.0-test" })(args),
      { rootCommand: requiredFlagCommand, args },
    ).pipe(Effect.provide(layerFor(args, console)));

  test("an unrecognized flag: replays the help dump to stderr (never stdout) and drops the duplicate error, but still fails with the original cause", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runBranches(["--this-flag-does-not-exist"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);

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

    expect(calls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("a required flag present on argv but missing its value: replays the help dump to stderr instead of dropping it", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["--type"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("a required flag present on argv by its short alias but missing its value: replays the help dump to stderr instead of dropping it", async () => {
    const { console, calls } = fakeConsole();
    const exit = await Effect.runPromiseExit(runRequiredFlagCommand(["-t"], console));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith("error:"))).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(exitCodeForFailure(exit.cause)).toBe(1);
  });

  test("an invalid Flag.Literals value: replays the help dump to stderr (never stdout) and drops the duplicate error, but still fails with the original cause", async () => {
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

describe("nested command parsing", () => {
  test("forwards operands after -- to a nested variadic argument", async () => {
    let receivedPaths: ReadonlyArray<string> = [];
    const db = Command.make("db", {
      paths: Argument.String("path").pipe(Argument.variadic()),
    }).pipe(
      Command.withHandler(({ paths }) =>
        Effect.sync(() => {
          receivedPaths = paths;
        }),
      ),
    );
    const testCommand = Command.make("test").pipe(Command.withSubcommands([db]));
    const root = Command.make("supabase").pipe(Command.withSubcommands([testCommand]));
    const args = ["test", "db", "--", "-foo.sql", "--literal"];

    const exit = await Effect.runPromiseExit(
      Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliOutput.layer(textCliOutputFormatter()),
            Layer.succeed(CliArgs, { args }),
            mockOutput({ format: "text" }).layer,
            emptyEnv(),
          ),
        ),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(receivedPaths).toEqual(["-foo.sql", "--literal"]);
  });
});
