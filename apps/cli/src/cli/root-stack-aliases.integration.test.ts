import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";
import { emptyEnv, fakeConsole, mockOutput } from "../../tests/helpers/mocks.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../shared/output/text-formatter.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../command-internal/global-flags.ts";
import { stackStartAliasCommand, stackStatusAliasCommand, stackStopAliasCommand } from "./root.ts";

const layerFor = (args: ReadonlyArray<string>, console: Console.Console) =>
  Layer.mergeAll(
    emptyEnv(),
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(CliArgs, { args }),
    Layer.succeed(Console.Console, console),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(YesFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    mockOutput({ format: "text" }).layer,
  );

// The stack backend aliases `stack start`/`stack status`/`stack stop` to the top-level
// `start`/`status`/`stop` commands (root.ts) — their `--help` text must describe the
// top-level command, not leak the `stack <name>` invocation it is built from.
describe("stack backend top-level alias help text", () => {
  it.effect("`start --help` describes the top-level command, not `stack start`", () =>
    Effect.gen(function* () {
      const { console, calls } = fakeConsole();
      yield* Effect.scoped(
        Command.runWith(stackStartAliasCommand, { version: "0.0.0-test" })(["--help"]).pipe(
          Effect.provide(layerFor(["--help"], console)),
        ),
      );
      const text = calls.join("\n");
      expect(text).toContain("supabase start");
      expect(text).not.toContain("stack start");
      expect(text).not.toContain("Start a managed local stack");
    }),
  );

  it.effect("`status --help` describes the top-level command, not `stack status`", () =>
    Effect.gen(function* () {
      const { console, calls } = fakeConsole();
      yield* Effect.scoped(
        Command.runWith(stackStatusAliasCommand, { version: "0.0.0-test" })(["--help"]).pipe(
          Effect.provide(layerFor(["--help"], console)),
        ),
      );
      const text = calls.join("\n");
      expect(text).toContain("supabase status");
      expect(text).not.toContain("stack status");
    }),
  );

  it.effect("`stop --help` describes the top-level command, not `stack stop`", () =>
    Effect.gen(function* () {
      const { console, calls } = fakeConsole();
      yield* Effect.scoped(
        Command.runWith(stackStopAliasCommand, { version: "0.0.0-test" })(["--help"]).pipe(
          Effect.provide(layerFor(["--help"], console)),
        ),
      );
      const text = calls.join("\n");
      expect(text).toContain("supabase stop");
      expect(text).not.toContain("stack stop");
    }),
  );
});
