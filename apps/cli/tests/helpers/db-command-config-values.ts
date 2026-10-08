import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";
import { CliConfigValues } from "../../src/config/cli-config-values.service.ts";
import type { Output } from "../../src/shared/output/output.service.ts";
import { withHermeticShellTier } from "./config-snapshot-layer.ts";

export const flagInput = (path: string, flag: string, value: unknown) =>
  [path, { path, flag, value }] as const;

/**
 * A real `CliConfigValues` over the test workdir with flag-tier assignments and shell env pinned.
 * Only `options.env` and the pins in scope at each load form the shell tier, so ambient
 * `process.env` never leaks in.
 */
export const dbCommandConfigValuesLayer = (
  outputLayer: Layer.Layer<Output>,
  options: {
    readonly flags?: ReadonlyArray<ReturnType<typeof flagInput>>;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) =>
  Layer.effect(
    CliConfigValues,
    Effect.map(Effect.service(CliConfigValues), (real) => withHermeticShellTier(real, options.env)),
  ).pipe(
    Layer.provide(
      cliConfigValuesLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            outputLayer,
            Layer.succeed(CliConfigFlagInputs, new Map(options.flags ?? [])),
          ),
        ),
      ),
    ),
  );
