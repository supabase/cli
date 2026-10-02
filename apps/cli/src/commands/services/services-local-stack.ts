import {
  artifactServiceKinds,
  postgresVersion,
  resolveArtifact,
} from "@supabase/stack/internal/artifacts";
import { Effect, Result } from "effect";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import {
  envOverride,
  envOverrideMajorVersion,
} from "../../command-internal/local-config-values.ts";
import { stackDatabaseVersion } from "../../command-internal/stack-database-version.ts";
import { upstreamVersionFromTag } from "../../shared/services/services.shared.ts";
import type { ServiceVersionRow } from "../../shared/services/services.shared.ts";
import type { RemoteServiceName } from "../../shared/services/services.shared.ts";

const remoteNames: Readonly<Record<string, RemoteServiceName | undefined>> = {
  database: "postgres",
  auth: "auth",
  rest: "postgrest",
  storage: "storage",
};

export const stackServiceVersions = Effect.fn("services.stackServiceVersions")(function* (
  workdir: string,
  remote: Partial<Record<RemoteServiceName, string>> = {},
) {
  const context = yield* loadLocalProjectContext(workdir, (message) => message).pipe(Effect.result);
  let configError: string | undefined;
  let databaseVersion: string | undefined;
  if (Result.isFailure(context)) configError = context.failure;
  else {
    const { config, projectEnvValues } = context.success;
    const resolved = yield* Effect.try({
      try: () => {
        const value = envOverrideMajorVersion(config.db.major_version, projectEnvValues);
        if (value !== 15 && value !== 17)
          throw new Error(`unsupported PostgreSQL major version: ${value}`);
        return stackDatabaseVersion({
          major_version: value,
          orioledb_version: envOverride(
            "SUPABASE_DB_ORIOLEDB_VERSION",
            config.db.orioledb_version,
            projectEnvValues,
          ),
        });
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.flatMap(Effect.fromResult), Effect.result);
    if (Result.isFailure(resolved)) configError = resolved.failure;
    else databaseVersion = resolved.success;
  }
  yield* Effect.annotateCurrentSpan({ "config.load_failed": configError !== undefined });
  return yield* Effect.forEach(artifactServiceKinds(), (service) =>
    Effect.gen(function* () {
      const artifact = yield* resolveArtifact({
        service,
        ...(service === "database" && databaseVersion !== undefined
          ? { version: postgresVersion(databaseVersion) }
          : {}),
      });
      const name = artifact.image.split("@")[0]?.replace(/:[^/:]+$/, "") ?? artifact.image;
      const remoteName = remoteNames[service];
      return {
        name,
        // A slim revision suffix (`-rN`) repackages the same upstream release.
        local: upstreamVersionFromTag(artifact.version),
        remote: remoteName === undefined ? "" : (remote[remoteName] ?? ""),
      } satisfies ServiceVersionRow;
    }),
  ).pipe(Effect.map((rows) => ({ rows, configError })));
});
