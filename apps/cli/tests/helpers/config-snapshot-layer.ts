import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";

import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { mockOutput } from "./mocks.ts";

/**
 * The real `CliConfigValues` service over the real filesystem, with no config flags bound. It
 * also appends a `ConfigProvider` over `process.env` as of layer build, behind any pin from
 * `withConfigEnv`, so `withEnvVar` is seen too; it is rebuilt per provide so no snapshot memo leaks.
 */
export const cliConfigValuesTestLayer = Layer.fresh(
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
    ConfigProvider.layerAdd(
      Effect.sync(() => ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true })),
    ),
  ),
);
