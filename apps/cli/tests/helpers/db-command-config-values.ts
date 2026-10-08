import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Layer } from "effect";
import type { Output } from "../../src/shared/output/output.service.ts";
import { CliConfigFlagInputs } from "../../src/config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../src/config/cli-config-values.layer.ts";

export const flagInput = (path: string, flag: string, value: unknown) =>
  [path, { path, flag, value }] as const;

/** A real `CliConfigValues` over the test workdir; shell env and flag-tier assignments are pinned. */
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
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(options.env ?? {}, { preserveEmptyStrings: true }),
        ),
        Layer.succeed(CliConfigFlagInputs, new Map(options.flags ?? [])),
      ),
    ),
  );
