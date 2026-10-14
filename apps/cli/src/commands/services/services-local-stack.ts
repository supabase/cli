import {
  artifactServiceKinds,
  postgresVersion,
  resolveArtifact,
} from "@supabase/stack/internal/artifacts";
import { Effect, Result } from "effect";
import { isConfigValueFailure } from "../../command-internal/config-value-passthrough.ts";
import {
  describeConfigLoadFailure,
  loadResolvedConfigContext,
} from "../../command-internal/resolved-config-context.ts";
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
  const context = yield* loadResolvedConfigContext(workdir).pipe(Effect.result);
  let configError: string | undefined;
  let databaseVersion: string | undefined;
  if (Result.isFailure(context)) {
    if (isConfigValueFailure(context.failure)) return yield* context.failure;
    configError = describeConfigLoadFailure(context.failure);
  } else {
    const { db } = context.success.config;
    if (db.major_version !== 15 && db.major_version !== 17) {
      configError = `unsupported PostgreSQL major version: ${db.major_version}`;
    } else {
      const resolved = stackDatabaseVersion(db);
      if (Result.isFailure(resolved)) configError = resolved.failure;
      else databaseVersion = resolved.success;
    }
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
