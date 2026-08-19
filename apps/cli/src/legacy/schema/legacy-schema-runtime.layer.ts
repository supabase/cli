import { Effect, Layer, Option } from "effect";
import { schemaRuntimeLayer } from "../../shared/schema/schema-runtime.layer.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyNextCliConfigLayer } from "../config/legacy-next-cli-config.layer.ts";
import { legacyDockerLocalDatabaseFallbackLayer } from "./legacy-docker-local-database.layer.ts";
import { legacySchemaProjectLinkStateLayer } from "./legacy-schema-project-link-state.layer.ts";
import { legacyDebugLoggerLayer } from "../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";

const legacyCliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

export const legacySchemaRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      const runtimeInfo = yield* RuntimeInfo;
      const debugLogger = yield* Effect.serviceOption(LegacyDebugLogger);
      const runtime = Layer.succeed(
        RuntimeInfo,
        RuntimeInfo.of({
          ...runtimeInfo,
          cwd: config.workdir,
        }),
      );
      return schemaRuntimeLayer(commandPath, {
        runtimeInfo: runtime,
        cliConfig: legacyNextCliConfigLayer.pipe(
          Layer.provide(Layer.succeed(LegacyCliConfig, config)),
          Layer.provide(runtime),
          Layer.provide(
            Option.match(debugLogger, {
              onNone: () => Layer.empty,
              onSome: (logger) => Layer.succeed(LegacyDebugLogger, logger),
            }),
          ),
        ),
        localDatabaseFallback: legacyDockerLocalDatabaseFallbackLayer.pipe(
          Layer.provide(Layer.succeed(LegacyCliConfig, config)),
        ),
        projectLinkState: legacySchemaProjectLinkStateLayer.pipe(
          Layer.provide(Layer.succeed(LegacyCliConfig, config)),
        ),
      });
    }),
  ).pipe(Layer.provide(legacyCliConfig), Layer.provide(legacyDebugLoggerLayer));
