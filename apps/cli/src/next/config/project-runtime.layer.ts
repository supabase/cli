import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { runtimeInfoLayer } from "../../shared/runtime/runtime-info.layer.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { CliConfig } from "./cli-config.service.ts";
import { cliConfigLayer } from "./cli-config.layer.ts";
import { projectContextLayer } from "./project-context.layer.ts";
import { projectHomeLayer } from "./project-home.layer.ts";

export type ProjectCommandRuntimeOptions = {
  readonly runtimeInfo?: Layer.Layer<RuntimeInfo>;
  readonly cliConfig?: Layer.Layer<CliConfig>;
};

const makeDiscoveredProjectContextLayer = (runtimeInfo: Layer.Layer<RuntimeInfo>) =>
  projectContextLayer.pipe(Layer.provide(runtimeInfo), Layer.provide(BunServices.layer));

const makeDiscoveredCliConfigLayer = (runtimeInfo: Layer.Layer<RuntimeInfo>) =>
  cliConfigLayer.pipe(
    Layer.provide(makeDiscoveredProjectContextLayer(runtimeInfo)),
    Layer.provide(runtimeInfo),
  );

const makeDiscoveredProjectHomeLayer = (runtimeInfo: Layer.Layer<RuntimeInfo>) =>
  projectHomeLayer.pipe(
    Layer.provide(makeDiscoveredProjectContextLayer(runtimeInfo)),
    Layer.provide(runtimeInfo),
    Layer.provide(BunServices.layer),
  );

const discoveredProjectContextLayer = makeDiscoveredProjectContextLayer(runtimeInfoLayer);

export const discoveredCliConfigLayer = makeDiscoveredCliConfigLayer(runtimeInfoLayer);

const discoveredProjectHomeLayer = makeDiscoveredProjectHomeLayer(runtimeInfoLayer);

export const projectCommandBaseLayer = Layer.mergeAll(
  discoveredProjectHomeLayer,
  discoveredCliConfigLayer,
).pipe(
  Layer.provide(discoveredProjectContextLayer),
  Layer.provide(runtimeInfoLayer),
  Layer.provide(BunServices.layer),
);

export const provideProjectCommandRuntime = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
  options?: ProjectCommandRuntimeOptions,
) => {
  const runtimeInfo = options?.runtimeInfo ?? runtimeInfoLayer;
  const projectContext = makeDiscoveredProjectContextLayer(runtimeInfo);
  const cliConfig =
    options?.cliConfig ??
    cliConfigLayer.pipe(Layer.provide(projectContext), Layer.provide(runtimeInfo));
  return layer.pipe(
    Layer.provide(
      projectHomeLayer.pipe(
        Layer.provide(projectContext),
        Layer.provide(runtimeInfo),
        Layer.provide(BunServices.layer),
      ),
    ),
    Layer.provide(cliConfig),
    Layer.provide(projectContext),
    Layer.provide(runtimeInfo),
    Layer.provide(BunServices.layer),
  );
};
