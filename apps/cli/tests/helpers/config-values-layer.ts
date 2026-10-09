import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";

import {
  CliConfigFlagInputs,
  makeCliConfigFlagInputs,
  type CliConfigFlagAssignment,
} from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { CliConfigValues } from "../../src/config/cli-config-values.service.ts";
import type { DebugLogger } from "../../src/shared/output/debug-logger.service.ts";
import type { Output } from "../../src/shared/output/output.service.ts";
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

export const flagInput = (path: string, flag: string, value: unknown): CliConfigFlagAssignment => ({
  path,
  flag,
  value,
});

/**
 * The real `CliConfigValues` service over the real filesystem, rebuilt per provide so no resolved config
 * memo leaks. Its shell tier holds only `options.env` and the pins in scope at each load
 * (`withConfigEnv`, `withEnvVar`, `processEnvLayer`), never the ambient `process.env`.
 */
export const configValuesLayer = (
  options: {
    readonly output?: Layer.Layer<Output>;
    readonly flags?: ReadonlyArray<CliConfigFlagAssignment>;
    readonly env?: Readonly<Record<string, string>>;
    readonly debugLogger?: Layer.Layer<DebugLogger>;
  } = {},
) =>
  Layer.fresh(
    Layer.effect(
      CliConfigValues,
      Effect.map(Effect.service(CliConfigValues), (real) =>
        withHermeticShellTier(real, options.env),
      ),
    ).pipe(
      Layer.provide(
        cliConfigValuesLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              BunServices.layer,
              options.output ?? mockOutput().layer,
              options.debugLogger ?? Layer.empty,
              Layer.succeed(CliConfigFlagInputs, makeCliConfigFlagInputs(options.flags)),
            ),
          ),
        ),
      ),
    ),
  );

/** {@link configValuesLayer} with no flags bound and no env. */
export const cliConfigValuesTestLayer = configValuesLayer();
