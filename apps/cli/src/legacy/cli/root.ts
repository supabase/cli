import { Effect, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { helloLegacyCommand } from "../commands/hello/hello.command.ts";
import { jsonCliOutputFormatter } from "../../shared/output/json-formatter.ts";
import { outputLayerFor } from "../../shared/output/output.layer.ts";
import { OutputFormatFlag } from "../../shared/cli/global-flags.ts";

export const legacyRoot = Command.make("supabase").pipe(
  Command.withDescription("Legacy Supabase CLI shell."),
  Command.withSubcommands([helloLegacyCommand]),
  Command.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const outputFormat = yield* OutputFormatFlag;
        const base = outputLayerFor(outputFormat);
        if (outputFormat === "text") return base;
        return Layer.merge(base, CliOutput.layer(jsonCliOutputFormatter()));
      }),
    ),
  ),
  Command.withGlobalFlags([OutputFormatFlag]),
);
