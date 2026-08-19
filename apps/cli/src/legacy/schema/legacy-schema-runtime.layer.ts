import { Effect, Layer, Option } from "effect";
import { schemaRuntimeLayer } from "../../shared/schema/schema-runtime.layer.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyNextCliConfigLayer } from "../config/legacy-next-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";
import { legacyIdentityStitchLayer } from "../shared/legacy-identity-stitch.ts";
import { legacyDockerLocalDatabaseFallbackLayer } from "./legacy-docker-local-database.layer.ts";
import { legacyLinkedRemoteConnectorLayer } from "./legacy-linked-remote-connector.layer.ts";
import { legacySchemaProjectLinkStateLayer } from "./legacy-schema-project-link-state.layer.ts";

const legacyCliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacySchemaDbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(legacyCliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

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
        linkedRemoteConnector: legacyLinkedRemoteConnectorLayer.pipe(
          Layer.provide(legacySchemaDbConfig),
        ),
      });
    }),
  ).pipe(Layer.provide(legacyCliConfig), Layer.provide(legacyDebugLoggerLayer));
