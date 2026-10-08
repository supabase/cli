import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import type { Output } from "../../src/shared/output/output.service.ts";
import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";

export const flagInput = (path: string, flag: string, value: unknown) =>
  [path, { path, flag, value }] as const;

const processEnvProvider = Effect.sync(() =>
  ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true }),
);

/**
 * A real `CliConfigValues` over the test workdir with flag-tier assignments and shell env pinned.
 * `process.env` as of layer build is read behind the pins, so a surrounding `withEnvVar` is seen.
 */
export const dbCommandConfigValuesLayer = (
  outputLayer: Layer.Layer<Output>,
  options: {
    readonly flags?: ReadonlyArray<ReturnType<typeof flagInput>>;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) =>
  cliConfigValuesLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        BunServices.layer,
        outputLayer,
        ConfigProvider.layer(
          Effect.map(processEnvProvider, (ambient) =>
            ConfigProvider.orElse(
              ConfigProvider.fromEnvRecord(options.env ?? {}, { preserveEmptyStrings: true }),
              ambient,
            ),
          ),
        ),
        Layer.succeed(CliConfigFlagInputs, new Map(options.flags ?? [])),
      ),
    ),
  );
