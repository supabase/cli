import { BunCrypto, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";
import { CliOutput, Command } from "effect/cli";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { legacyProjectStateLayer } from "../../shared/config/legacy-project-state.layer.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { LogsInputError } from "./logs.errors.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";

const root = rootCommandForFeatures();
const cases = ["", "sources"];
const formats = ["pretty", "table", "json", "csv", "env", "yaml", "toml"];

describe("logs output format parsing", () => {
  for (const leaf of cases) {
    for (const format of formats) {
      it.effect(`rejects legacy -o ${format} for logs ${leaf}`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "logs-output-" });
          const args = ["logs", ...(leaf === "" ? [] : [leaf]), "--workdir", home, "-o", format];
          const exit = yield* Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
            Effect.provide(
              Layer.mergeAll(
                CliOutput.layer(textCliOutputFormatter()),
                Layer.succeed(CliArgs, { args }),
                mockOutput({ format: "text" }).layer,
                BunServices.layer,
                BunCrypto.layer,
                legacyProjectStateLayer.pipe(Layer.provide(BunServices.layer)),
                mockRuntimeInfo({ homeDir: home, cwd: home }),
                mockAnalytics().layer,
                mockTelemetryRuntime({ configDir: home }),
                mockTty(),
                mockProcessControl().layer,
                processEnvLayer({ SUPABASE_HOME: home }),
              ),
            ),
            Effect.exit,
          );
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          expect(error).toBeInstanceOf(LogsInputError);
          expect(error).toMatchObject({
            message: `the -o/--output flag is not supported by ${leaf === "" ? "logs" : `logs ${leaf}`}; use --output-format json|stream-json instead.`,
          });
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      );
    }
  }
});
