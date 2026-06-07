import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { runtimeInfoLayer } from "../../shared/runtime/runtime-info.layer.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";

const discoveredProjectContextLayer = projectContextLayer.pipe(
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const discoveredCliConfigLayer = cliConfigLayer.pipe(
  Layer.provide(discoveredProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
);

const discoveredProjectHomeLayer = projectHomeLayer.pipe(
  Layer.provide(discoveredProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const projectCommandBaseLayer = Layer.mergeAll(
  discoveredProjectHomeLayer,
  discoveredCliConfigLayer,
).pipe(
  Layer.provide(discoveredProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const provideProjectCommandRuntime = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  layer.pipe(
    Layer.provide(discoveredProjectHomeLayer),
    Layer.provide(discoveredCliConfigLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(BunServices.layer),
  );
