import {
  artifactServiceKinds,
  postgresVersion,
  resolveArtifact,
} from "@supabase/stack/internal/artifacts";
import { Effect, Result } from "effect";
import {
  describeConfigSnapshotFailure,
  loadConfigSnapshotContext,
} from "../../command-internal/config-snapshot-context.ts";
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
  const context = yield* loadConfigSnapshotContext(workdir).pipe(Effect.result);
  let configError: string | undefined;
  let major: number | undefined;
  if (Result.isFailure(context)) configError = describeConfigSnapshotFailure(context.failure);
  else {
    const value = context.success.config.db.major_version;
    if (value !== 15 && value !== 17)
      configError = `unsupported PostgreSQL major version: ${value}`;
    else major = value;
  }
  yield* Effect.annotateCurrentSpan({ "config.load_failed": configError !== undefined });
  return yield* Effect.forEach(artifactServiceKinds(), (service) =>
    Effect.gen(function* () {
      const artifact = yield* resolveArtifact({
        service,
        ...(service === "database" && major !== undefined
          ? { version: postgresVersion(String(major)) }
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
