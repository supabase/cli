import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { runtimeInfoLayer } from "../../shared/runtime/runtime-info.layer.ts";
import { cliSettingsLayer } from "./cli-settings.layer.ts";
import { cliProjectContextLayer } from "./cli-project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";

const discoveredCliProjectContextLayer = cliProjectContextLayer.pipe(
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const discoveredCliSettingsLayer = cliSettingsLayer.pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
);

const discoveredProjectHomeLayer = projectHomeLayer.pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const projectCommandBaseLayer = Layer.mergeAll(
  discoveredProjectHomeLayer,
  discoveredCliSettingsLayer,
).pipe(
  Layer.provide(discoveredCliProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const provideProjectCommandRuntime = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  layer.pipe(
    Layer.provide(discoveredProjectHomeLayer),
    Layer.provide(discoveredCliSettingsLayer),
    Layer.provide(discoveredCliProjectContextLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(BunServices.layer),
  );
