import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/cli";
import { emptyEnv, fakeConsole, mockOutput } from "../../tests/helpers/mocks.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { withoutParseErrorHelpDump } from "../shared/cli/run.ts";
import { normalizeCause } from "../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../shared/output/text-formatter.ts";
import { rootCommandForFeatures } from "./root.ts";

const legacyRoot = rootCommandForFeatures({ stackBackend: "legacy" });
const stackRoot = rootCommandForFeatures({ stackBackend: "stack" });

type Root = typeof legacyRoot;

const optInAdvice =
  "Set SUPABASE_EXPERIMENTAL_STACK=1, or set stack = true under [experimental] in your project config and leave SUPABASE_EXPERIMENTAL_STACK unset.";

/** Parses `args` against `root` and returns the normalized failure message `runCli` reports. */
const parse = (
  root: Root,
  args: ReadonlyArray<string>,
  options: { readonly stackRoot?: Root } = {},
) =>
  Effect.gen(function* () {
    const context = {
      rootCommand: root,
      args,
      ...(options.stackRoot ? { stackRootCommand: options.stackRoot } : {}),
    };
    const exit = yield* withoutParseErrorHelpDump(
      Command.runWith(root, { version: "0.0.0-test" })(args),
      context,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          emptyEnv(),
          CliOutput.layer(textCliOutputFormatter(context)),
          Layer.succeed(CliArgs, { args }),
          Layer.succeed(Console.Console, fakeConsole().console),
          mockOutput({ format: "text" }).layer,
        ),
      ),
      Effect.exit,
    );
    if (Exit.isSuccess(exit)) return { failed: false, message: "" };
    return { failed: true, message: normalizeCause(exit.cause, context).message };
  });

describe("stack-only flags rejected by the legacy backend", () => {
  const stackOnlyInvocations: ReadonlyArray<ReadonlyArray<string>> = [
    ["start", "--runtime", "native"],
    ["start", "--stack", "feature-a"],
    ["start", "--stack-id", "feature-a"],
    ["start", "--preparation", "frozen"],
    ["start", "--frozen"],
    ["start", "--eager"],
    ["stop", "--stack", "feature-a"],
    ["status", "--stack", "feature-a"],
  ];

  for (const args of stackOnlyInvocations) {
    const [command, flag] = args;
    it.effect(`\`${command} ${flag}\` names the stack opt-in`, () =>
      Effect.gen(function* () {
        const result = yield* parse(legacyRoot, args, { stackRoot });
        expect(result.failed).toBe(true);
        expect(result.message).toContain(`Unrecognized flag: ${flag}`);
        expect(result.message).toContain(`Hint: ${flag} needs the stack backend. ${optInAdvice}`);
      }),
    );
  }

  it.effect("adds no hint for a flag neither backend accepts", () =>
    Effect.gen(function* () {
      const { message } = yield* parse(legacyRoot, ["start", "--bogus"], { stackRoot });
      expect(message).toContain("Unrecognized flag: --bogus");
      expect(message).not.toContain("Hint:");
    }),
  );

  it.effect("adds no hint when the stack opt-in is not offered", () =>
    Effect.gen(function* () {
      const { message } = yield* parse(legacyRoot, ["start", "--runtime", "native"]);
      expect(message).toContain("Unrecognized flag: --runtime");
      expect(message).not.toContain("Hint:");
    }),
  );

  it.effect("the stack backend's own start recognizes the flag", () =>
    Effect.gen(function* () {
      const result = yield* parse(stackRoot, ["start", "--runtime", "bogus"]);
      expect(result.failed).toBe(true);
      expect(result.message).toContain('Invalid value for flag --runtime: "bogus"');
    }),
  );
});
