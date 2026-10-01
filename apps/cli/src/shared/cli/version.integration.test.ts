import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Schema, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { rootCommand } from "../../cli/root.ts";
import { emptyEnv, fakeConsole, mockOutput } from "../../../tests/helpers/mocks.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import { CliArgs } from "./cli-args.service.ts";
import { CLI_VERSION } from "./version.ts";

const builtinLayer = (args: ReadonlyArray<string>, console: Console.Console) =>
  Layer.mergeAll(
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(CliArgs, { args }),
    Layer.succeed(Console.Console, console),
    mockOutput({ format: "text" }).layer,
    emptyEnv(),
  );

describe("CLI --help (text)", () => {
  it.effect("source runs describe themselves as a development build", () =>
    Effect.gen(function* () {
      const { console, calls } = fakeConsole();
      yield* Command.runWith(rootCommand, { version: CLI_VERSION })(["--help"]).pipe(
        Effect.provide(builtinLayer(["--help"], console)),
      );
      const help = calls.join("\n");
      expect(help).toContain("Supabase CLI (development build).");
      expect(help).not.toContain("stable channel");
    }),
  );
});

describe("CLI --version (text)", () => {
  it.effect("CLI prints bare semver on stdout", () =>
    Effect.gen(function* () {
      const version = "2.99.0-beta.1";
      const { console, calls } = fakeConsole();
      yield* Command.runWith(rootCommand, { version })(["--version"]).pipe(
        Effect.provide(builtinLayer(["--version"], console)),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]).toBe(`log:${version}`);
      expect(calls[0]).not.toMatch(/supabase\s+v/i);
    }),
  );

  it.live("source execution ignores a runtime version environment variable", () =>
    Effect.gen(function* () {
      const bunExecutable = yield* Effect.fromNullishOr(Bun.which("bun"));
      const versionModule = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
        fileURLToPath(new URL("./version.ts", import.meta.url)),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          bunExecutable,
          ["-e", `import { CLI_VERSION } from ${versionModule}; console.log(CLI_VERSION);`],
          {
            env: { SUPABASE_CLI_VERSION: "9.9.9" },
            extendEnv: true,
            stdin: "ignore",
          },
        ),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: "unbounded" },
      );

      expect(exitCode, stderr).toBe(0);
      expect(stdout.trim()).toBe("0.0.0-dev");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
