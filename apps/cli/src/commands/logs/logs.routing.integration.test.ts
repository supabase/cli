import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Sink, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { resolveComputeEnabled } from "../experimental/compute/compute-backend.ts";
import { withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { legacyProjectStateLayer } from "../../shared/config/legacy-project-state.layer.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";

it.effect.each([
  { configured: true, override: undefined, expected: true },
  { configured: true, override: "0", expected: false },
  { configured: false, override: "1", expected: true },
])(
  "routes configured Compute log sources with config $configured and override $override",
  ({ configured, override, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "logs-routing-" });
      yield* fs.makeDirectory(`${home}/supabase`);
      yield* fs.writeFileString(
        `${home}/supabase/config.toml`,
        `[experimental]\ncompute = ${configured}\n`,
      );
      const env = override === undefined ? {} : { SUPABASE_EXPERIMENTAL_COMPUTE: override };
      const args = [
        "logs",
        "sources",
        "--remote=abcdefghijklmnopqrst",
        "--workdir",
        home,
        "--output-format",
        "json",
      ];
      const computeEnabled = yield* withConfigEnv(env, resolveComputeEnabled({ args, cwd: home }));
      const chunks: string[] = [];
      yield* Command.runWith(rootCommandForFeatures({ computeEnabled }), { version: "test" })(
        args,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliOutput.layer(textCliOutputFormatter()),
            Layer.succeed(CliArgs, { args }),
            mockOutput({ format: "text" }).layer,
            BunServices.layer,
            legacyProjectStateLayer.pipe(Layer.provide(BunServices.layer)),
            mockRuntimeInfo({ homeDir: home, cwd: home }),
            mockAnalytics().layer,
            mockTelemetryRuntime({ configDir: home }),
            mockTty(),
            mockProcessControl().layer,
            processEnvLayer({ ...env, SUPABASE_HOME: home }),
            Stdio.layerTest({
              args: Effect.succeed(args),
              stdout: () =>
                Sink.forEach((part: string | Uint8Array) =>
                  Effect.sync(() => {
                    chunks.push(typeof part === "string" ? part : new TextDecoder().decode(part));
                  }),
                ),
            }),
          ),
        ),
      );
      expect(chunks.join("").includes('"compute"')).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
