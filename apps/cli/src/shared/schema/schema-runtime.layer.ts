import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { unixHttpClientLayer } from "@supabase/stack/effect";
import { projectLinkStateLayer } from "../../next/config/project-link-state.layer.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { projectLocalServiceVersionsLayer } from "../../next/config/project-local-service-versions.layer.ts";
import {
  provideProjectCommandRuntime,
  type ProjectCommandRuntimeOptions,
} from "../../next/config/project-runtime.layer.ts";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import {
  noLocalDatabaseFallbackLayer,
  type LocalDatabaseFallback,
} from "../database/local-database-fallback.service.ts";
import {
  failClosedLinkedRemoteConnectorLayer,
  LinkedRemoteConnector,
} from "../database/linked-remote-connector.service.ts";
import { commandRuntimeLayer } from "../runtime/command-runtime.layer.ts";
import { databaseTargetLayer } from "./database-target.layer.ts";
import { nativeIsolatedShadowLayer } from "./native-isolated-shadow.layer.ts";
import { schemaWorkspaceLayer } from "./schema-workspace.layer.ts";
import { schemaStateLayer } from "./schema-state.layer.ts";
import { pgDeltaSchemaEngineLayer } from "./pg-delta-engine.layer.ts";
import { migrationRepositoryLayer } from "../migrations/migration-repository.layer.ts";
import { migrationRunnerLayer } from "../migrations/migration-runner.layer.ts";

const workspaceFromProjectHome = Layer.unwrap(
  Effect.gen(function* () {
    const projectHome = yield* ProjectHome;
    return schemaWorkspaceLayer({
      projectRoot: projectHome.projectRoot,
      supabaseDir: projectHome.supabaseDir,
      projectHomeDir: projectHome.projectHomeDir,
    });
  }),
);

export type SchemaRuntimeOptions = ProjectCommandRuntimeOptions & {
  readonly localDatabaseFallback?: Layer.Layer<
    LocalDatabaseFallback,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly projectLinkState?: Layer.Layer<
    ProjectLinkState,
    never,
    FileSystem.FileSystem | Path.Path | ProjectHome
  >;
  readonly linkedRemoteConnector?: Layer.Layer<LinkedRemoteConnector, unknown, unknown>;
};

export const schemaRuntimeLayer = (
  commandPath: ReadonlyArray<string>,
  options?: SchemaRuntimeOptions,
) => {
  const linkState = options?.projectLinkState ?? projectLinkStateLayer;
  const linkedRemote = options?.linkedRemoteConnector ?? failClosedLinkedRemoteConnectorLayer;
  const schemaEngineLive = pgDeltaSchemaEngineLayer.pipe(
    Layer.provide(nativeIsolatedShadowLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(projectLocalServiceVersionsLayer),
    Layer.provide(linkState),
  );
  return provideProjectCommandRuntime(
    Layer.mergeAll(
      workspaceFromProjectHome,
      schemaStateLayer.pipe(Layer.provide(workspaceFromProjectHome)),
      migrationRepositoryLayer.pipe(Layer.provide(workspaceFromProjectHome)),
      migrationRunnerLayer,
      schemaEngineLive,
      databaseTargetLayer.pipe(
        Layer.provide(options?.localDatabaseFallback ?? noLocalDatabaseFallbackLayer),
        Layer.provide(linkState),
        Layer.provide(unixHttpClientLayer),
        Layer.provide(linkedRemote),
      ),
      linkedRemote,
      linkState,
      projectLocalServiceVersionsLayer,
      unixHttpClientLayer,
      commandRuntimeLayer(commandPath),
    ),
    options,
  );
};
