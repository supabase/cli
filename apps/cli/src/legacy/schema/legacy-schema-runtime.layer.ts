import { Effect, Layer, Path } from "effect";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { pgDeltaSchemaEngineLayer } from "../../shared/schema/pg-delta-engine.layer.ts";
import { schemaStateLayer } from "../../shared/schema/schema-state.layer.ts";
import { schemaWorkspaceLayer } from "../../shared/schema/schema-workspace.layer.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyHttpClientLayer } from "../auth/legacy-http-debug.layer.ts";
import { legacyDbConfigLayer } from "../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../shared/legacy-docker-run.layer.ts";
import { legacyIdentityStitchLayer } from "../shared/legacy-identity-stitch.ts";
import { legacyPgDeltaNextShadowLayer } from "../commands/db/shared/legacy-pgdelta-next-shadow.layer.ts";
import { legacyDockerIsolatedShadowLayer } from "./legacy-docker-isolated-shadow.layer.ts";
import { legacyDockerLocalDatabaseFallbackLayer } from "./legacy-docker-local-database.layer.ts";
import { legacyLinkedRemoteConnectorLayer } from "./legacy-linked-remote-connector.layer.ts";
import { legacyMigrationRepositoryLayer } from "./legacy-migration-repository.layer.ts";
import { legacyMigrationRunnerLayer } from "./legacy-migration-runner.layer.ts";
import { legacySchemaDatabaseTargetLayer } from "./legacy-schema-database-target.layer.ts";

const legacyCliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacySchemaDbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(legacyCliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const nextShadow = legacyPgDeltaNextShadowLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(httpClient),
);

const dockerShadows = legacyDockerIsolatedShadowLayer.pipe(
  Layer.provide(nextShadow),
  Layer.provide(legacyCliConfig),
);

const schemaEngine = pgDeltaSchemaEngineLayer.pipe(Layer.provide(dockerShadows));

export const legacySchemaRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* LegacyCliConfig;
      const path = yield* Path.Path;
      const workspace = schemaWorkspaceLayer({
        projectRoot: config.workdir,
        supabaseDir: path.join(config.workdir, "supabase"),
        projectHomeDir: path.join(config.workdir, ".supabase"),
      });
      const localDatabase = legacyDockerLocalDatabaseFallbackLayer.pipe(
        Layer.provide(Layer.succeed(LegacyCliConfig, config)),
      );
      const linkedRemote = legacyLinkedRemoteConnectorLayer.pipe(
        Layer.provide(legacySchemaDbConfig),
      );
      const targets = legacySchemaDatabaseTargetLayer.pipe(
        Layer.provide(localDatabase),
        Layer.provide(linkedRemote),
        Layer.provide(Layer.succeed(LegacyCliConfig, config)),
      );
      return Layer.mergeAll(
        workspace,
        schemaStateLayer.pipe(Layer.provide(workspace)),
        legacyMigrationRepositoryLayer.pipe(Layer.provide(workspace)),
        legacyMigrationRunnerLayer,
        schemaEngine,
        targets,
        linkedRemote,
        localDatabase,
        commandRuntimeLayer(commandPath),
      );
    }),
  ).pipe(Layer.provide(legacyCliConfig), Layer.provide(legacyDebugLoggerLayer));
