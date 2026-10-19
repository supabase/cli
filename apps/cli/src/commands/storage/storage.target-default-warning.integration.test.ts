import { describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/cli";

import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  isolatedHomeLayer,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { assertTargetDefaultWarning } from "../../../tests/helpers/target-default-warning.ts";
import { storageCommand } from "./storage.command.ts";

const tempRoot = useTempWorkdir("supabase-storage-warning-int-");

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
    Layer.succeed(CliArgs, { args }),
    isolatedHomeLayer(tempRoot.current, { SUPABASE_NO_KEYRING: "1" }),
    mockProcessControl().layer,
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
    mockAnalytics().layer,
    mockTelemetryRuntime({ configDir: `${tempRoot.current}/.supabase` }),
  );
  return { layer, out };
}

const selectors = [
  { label: "--linked", args: ["--linked"] },
  { label: "--linked=false", args: ["--linked=false"] },
  { label: "--local", args: ["--local"] },
  { label: "--project-ref", args: ["--project-ref", VALID_REF] },
] as const;

describe("storage target default warning", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "ls", args: ["storage", "ls", "ss:///bucket"] },
    { name: "cp", args: ["storage", "cp", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "mv", args: ["storage", "mv", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "rm", args: ["storage", "rm", "ss:///bucket/a"] },
  ];

  for (const { name, args } of leaves) {
    it.effect(`${name} warns on a bare run and stays silent with every selector`, () =>
      assertTargetDefaultWarning({
        command: `storage ${name}`,
        localTarget: "the local Storage API",
        sameTarget: selectors[0],
        selectors,
        run: (selector) => {
          const argv = [...args, "--experimental", ...(selector?.args ?? [])];
          const { layer, out } = setup(argv);
          return Command.runWith(testRoot, { version: "0.0.0-test" })(argv).pipe(
            Effect.exit,
            Effect.provide(layer),
            Effect.map(() => ({ stdout: out.stdoutText, stderr: out.stderrText })),
          );
        },
      }),
    );
  }
});
