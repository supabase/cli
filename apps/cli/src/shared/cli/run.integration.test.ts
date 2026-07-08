import { describe, expect, test } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";
import { exitCodeForFailure } from "./run.ts";

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
