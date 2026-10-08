import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";

import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { CliConfigValues } from "../../src/config/cli-config-values.service.ts";
import { pinnedConfigProvider } from "./config-env-pins.ts";
import { mockOutput } from "./mocks.ts";

/**
 * Runs every `load` of `real` over a shell tier built from `explicit` plus the pins in scope at
 * the call, never over the ambient `process.env`.
 */
export const withHermeticShellTier = (
  real: CliConfigValues["Service"],
  explicit: Readonly<Record<string, string>> = {},
): CliConfigValues["Service"] =>
  CliConfigValues.of({
    ...real,
    load: (target) =>
      Effect.flatMap(pinnedConfigProvider(explicit), (provider) =>
        Effect.provideService(real.load(target), ConfigProvider.ConfigProvider, provider),
      ),
  });

/**
 * The real `CliConfigValues` service over the real filesystem, with no config flags bound. Its
 * shell tier holds only what the test pinned through `withConfigEnv`, `withEnvVar` or
 * `processEnvLayer`; it is rebuilt per provide so no snapshot memo leaks.
 */
export const cliConfigValuesTestLayer = Layer.fresh(
  Layer.effect(
    CliConfigValues,
    Effect.map(Effect.service(CliConfigValues), (real) => withHermeticShellTier(real)),
  ).pipe(
    Layer.provide(
      cliConfigValuesLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockOutput().layer,
            Layer.succeed(CliConfigFlagInputs, new Map()),
          ),
        ),
      ),
    ),
  ),
);
