import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { runtimeInfoLayer } from "../../shared/runtime/runtime-info.layer.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { cliProjectHomeLayer } from "./cli-project-home.layer.ts";

const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
);

const discoveredCliProjectHomeLayer = cliProjectHomeLayer.pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const cliProjectCommandBaseLayer = Layer.mergeAll(
  discoveredCliProjectHomeLayer,
  discoveredCliSettingsLayer,
).pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const provideCliProjectCommandRuntime = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  layer.pipe(
    Layer.provide(discoveredCliProjectHomeLayer),
    Layer.provide(discoveredCliSettingsLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(BunServices.layer),
  );
