import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";

import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { mockOutput } from "./mocks.ts";

/**
 * The real `CliConfigValues` service reading the shell environment as it is when the layer builds,
 * so a `withEnvVar` pin around a test is seen. Unlike `cliConfigValuesTestLayer` it leaves
 * `process.env` untouched.
 */
export const cliConfigValuesAmbientTestLayer = Layer.fresh(
  Layer.merge(
    cliConfigValuesLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          BunServices.layer,
          mockOutput().layer,
          Layer.succeed(CliConfigFlagInputs, new Map()),
        ),
      ),
    ),
    ConfigProvider.layer(
      Effect.sync(() => ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })),
    ),
  ),
);
