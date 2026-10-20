import { describe, expect, it } from "@effect/vitest";
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
import { stripAnsi } from "../../../tests/helpers/ansi.ts";
import {
  assertTargetDefaultWarning,
  describeFailure,
  setLinkedRefFile,
  targetDefaultWarning,
} from "../../../tests/helpers/target-default-warning.ts";
import { storageCommand } from "./storage.command.ts";

const tempRoot = useTempWorkdir("supabase-storage-warning-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([storageCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup(args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) {
  const out = mockOutput({ format: "text" });
  const layer = Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    out.layer,
    Layer.succeed(CliArgs, { args }),
    isolatedHomeLayer(tempRoot.current, {
      SUPABASE_NO_KEYRING: "1",
      SUPABASE_WORKDIR: tempRoot.current,
      ...env,
    }),
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
    const runWith = (linked: boolean) => (selector: (typeof selectors)[number] | undefined) => {
      setLinkedRefFile(tempRoot.current, linked);
      const argv = [...args, "--experimental", ...(selector?.args ?? [])];
      const { layer, out } = setup(argv);
      return Command.runWith(testRoot, { version: "0.0.0-test" })(argv).pipe(
        Effect.exit,
        Effect.provide(layer),
        Effect.map((exit) => ({
          stdout: out.stdoutText,
          stderr: out.stderrText,
          failure: describeFailure(exit),
        })),
      );
    };

    it.effect(
      `${name} warns on a bare run in a linked workdir and stays silent with every selector or when unlinked`,
      () =>
        assertTargetDefaultWarning({
          command: `storage ${name}`,
          localTarget: "the local Storage API",
          sameTarget: selectors[0],
          selectors,
          run: runWith(true),
          runUnlinked: runWith(false),
          unlinkedFailure: "Cannot find project ref. Have you run supabase link?",
        }),
    );
  }

  it.effect(
    "warns on a bare run when only SUPABASE_PROJECT_ID configures the linked project",
    () => {
      const argv = ["storage", "ls", "ss:///bucket", "--experimental"];
      const { layer, out } = setup(argv, { SUPABASE_PROJECT_ID: VALID_REF });
      return Command.runWith(testRoot, { version: "0.0.0-test" })(argv).pipe(
        Effect.exit,
        Effect.provide(layer),
        Effect.map(() => {
          expect(stripAnsi(out.stderrText)).toBe(
            `${targetDefaultWarning("storage ls", "the local Storage API")}\n`,
          );
        }),
      );
    },
  );
});
