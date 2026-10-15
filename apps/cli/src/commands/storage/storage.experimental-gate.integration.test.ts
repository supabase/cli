import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { ExperimentalRequiredError } from "../../command-internal/experimental-gate.ts";
import { storageCommand } from "./storage.command.ts";
import { TargetSelectorConflictError } from "../../command-internal/target/target.errors.ts";
import { commandTargetLayer } from "../../shared/output/command-target.layer.ts";

const tempRoot = useTempWorkdir("supabase-storage-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([storageCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup(args: ReadonlyArray<string>) {
  const out = mockOutput({ format: "text" });
  const layer = Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    out.layer,
    commandTargetLayer.pipe(Layer.provide(out.layer)),
    Layer.succeed(CliArgs, { args }),
    // The cwd is a real directory so the handler's workdir check passes before the target conflict.
    mockRuntimeInfo({ homeDir: tempRoot.current, cwd: tempRoot.current }),
    processEnvLayer({ SUPABASE_NO_KEYRING: "1" }),
    mockProcessControl().layer,
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
    mockAnalytics().layer,
    mockTelemetryRuntime({
      configDir: `${tempRoot.current}/.supabase`,
    }),
  );
  return { layer };
}

describe("storage experimental gate vs mutual-exclusivity ordering", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "ls", args: ["storage", "ls", "ss:///bucket"] },
    { name: "cp", args: ["storage", "cp", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "mv", args: ["storage", "mv", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "rm", args: ["storage", "rm", "ss:///bucket/a"] },
  ];

  for (const { name, args } of leaves) {
    const conflictingArgs = [...args, "--linked", "--local"];

    it.effect(
      `${name} --linked --local without --experimental fails with the gate error, not the mutex error`,
      () => {
        const { layer } = setup(conflictingArgs);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(conflictingArgs),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) && failure.value instanceof ExperimentalRequiredError,
            ).toBe(true);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect(`${name} --linked --local with --experimental fails with the mutex error`, () => {
      const withExperimental = [...conflictingArgs, "--experimental"];
      const { layer } = setup(withExperimental);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })(withExperimental),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(
            Option.isSome(failure) && failure.value instanceof TargetSelectorConflictError,
          ).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    });
  }
});
