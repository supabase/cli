import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit } from "effect";
import { Argument, CliError, CliOutput, Command, Flag } from "effect/cli";
import { afterEach, beforeEach, vi } from "vitest";
import { fakeConsole } from "../../../tests/helpers/mocks.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { withoutParseErrorHelpDump } from "../cli/run.ts";
import { jsonCliOutputFormatter } from "./json-formatter.ts";
import { textCliOutputLayer } from "./text-cli-output.layer.ts";
import { textCliOutputFormatter } from "./text-formatter.ts";

const command = Command.make("supabase", {
  file: Argument.String("file").pipe(
    Argument.optional,
    Argument.withDescription("The `file` to read"),
  ),
  verbose: Flag.Boolean("verbose").pipe(Flag.withDescription("Print **details**")),
}).pipe(
  Command.withDescription(
    "Read **records** with [guide](https://example.com).\n\n```sh\necho '**literal**' > \"$HOME/file\"\n  echo done\n```",
  ),
  Command.withExamples([{ command: "supabase '**literal**'", description: "Read *one* file" }]),
  withTargetPolicy({ group: "local-only", consent: "none" }),
  withPermissions({ operations: [{ operationId: "v1-list-all-projects", kind: "required" }] }),
);

beforeEach(() => {
  for (const key of ["NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "CI"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

const color = { hasColors: () => true };
const pipe = {};

describe("text help presentation", () => {
  it.effect.each([
    {
      args: ["--help"],
      streams: { stdout: pipe, stderr: color },
      colored: false,
      method: "log:",
      success: true,
    },
    {
      args: ["--help"],
      streams: { stdout: color, stderr: pipe },
      colored: true,
      method: "log:",
      success: true,
    },
    {
      args: ["--unknown"],
      streams: { stdout: color, stderr: pipe },
      colored: false,
      method: "error:",
      success: false,
    },
    {
      args: ["--unknown"],
      streams: { stdout: pipe, stderr: color },
      colored: true,
      method: "error:",
      success: false,
    },
  ])(
    "uses the destination stream for $args with colors=$colored",
    ({ args, streams, colored, method, success }) =>
      Effect.gen(function* () {
        const { console, calls } = fakeConsole();
        const exit = yield* withoutParseErrorHelpDump(
          Command.runWith(command, { version: "test" })(args),
          { rootCommand: command, args },
        ).pipe(
          Effect.provide([
            textCliOutputLayer({ rootCommand: command, args }, streams),
            BunServices.layer,
          ]),
          Effect.provideService(Console.Console, console),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(success);
        expect(calls).toHaveLength(1);
        const output = calls.join("\n");
        expect(output.startsWith(method)).toBe(true);
        expect(output.includes("\u001b[")).toBe(colored);
        const plain = Bun.stripANSI(output);
        expect(plain).toContain("Read records with guide (https://example.com).");
        expect(plain).toContain("    echo '**literal**' > \"$HOME/file\"\n      echo done");
        expect(plain).not.toContain("```sh");
        expect(plain).toContain("Print details");
        expect(plain).toContain("The file to read");
        expect(plain).toContain("Read one file");
        expect(plain).toContain("supabase '**literal**'");
        expect(plain).toContain("TARGET\n  Local only.");
        expect(plain.indexOf("TARGET")).toBeLessThan(plain.indexOf("USAGE"));
        expect(plain).toContain("PERMISSIONS");
      }),
  );

  it.effect("forces help color on pipes but keeps version output unchanged", () =>
    Effect.gen(function* () {
      vi.stubEnv("CLICOLOR_FORCE", "1");
      const { console, calls } = fakeConsole();
      for (const args of [["--help"], ["--version"]]) {
        yield* Command.runWith(command, { version: "1.2.3" })(args).pipe(
          Effect.provide([
            textCliOutputLayer({ rootCommand: command, args }, { stdout: pipe, stderr: pipe }),
            BunServices.layer,
          ]),
          Effect.provideService(Console.Console, console),
        );
      }
      expect(calls[0]).toContain("\u001b[");
      expect(calls[1]).toBe("log:1.2.3");
    }),
  );

  it.effect("keeps JSON descriptions as Markdown even when color is forced", () =>
    Effect.gen(function* () {
      vi.stubEnv("CLICOLOR_FORCE", "1");
      const { console, calls } = fakeConsole();
      yield* Command.runWith(command, { version: "test" })(["--help"]).pipe(
        Effect.provide([CliOutput.layer(jsonCliOutputFormatter()), BunServices.layer]),
        Effect.provideService(Console.Console, console),
      );
      expect(calls).toHaveLength(1);
      const output = calls.join("");
      expect(output).toContain("Read **records** with [guide](https://example.com).");
      expect(output).toContain("```sh");
      expect(output).not.toContain("\u001b");
    }),
  );

  it("keeps non-help error formatting uncolored", () => {
    vi.stubEnv("CLICOLOR_FORCE", "1");
    const formatter = textCliOutputFormatter(undefined, color);
    expect(formatter.formatVersion("supabase", "1.2.3")).toBe("1.2.3");
    const error = formatter.formatErrors([
      new CliError.UnrecognizedOption({ option: "--bad", command: ["supabase"], suggestions: [] }),
    ]);
    expect(error).toContain("Unrecognized flag: --bad");
    expect(error).not.toContain("\u001b");
  });
});
