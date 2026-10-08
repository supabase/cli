import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";

import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { mockOutput, processEnvLayer } from "./mocks.ts";

/**
 * The real `CliConfigValues` service over the real filesystem, with no config flags bound. It
 * also installs a `ConfigProvider` over `process.env` as of layer build, so `withEnvVar` pins
 * around a test are seen, and is rebuilt per provide so no snapshot memo leaks between tests.
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
    processEnvLayer(),
  ),
);
