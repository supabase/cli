import {
  artifactServiceKinds,
  postgresVersion,
  resolveArtifact,
} from "@supabase/stack/internal/service-catalog";
import { Effect, Result } from "effect";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import { envOverrideMajorVersion } from "../../command-internal/local-config-values.ts";
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
  let major: number | undefined;
  if (Result.isFailure(context)) configError = context.failure;
  else {
    const resolvedMajor = yield* Effect.try({
      try: () => {
        const value = envOverrideMajorVersion(
          context.success.config.db.major_version,
          context.success.projectEnvValues,
        );
        if (value !== 15 && value !== 17)
          throw new Error(`unsupported PostgreSQL major version: ${value}`);
        return value;
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result);
    if (Result.isFailure(resolvedMajor)) configError = resolvedMajor.failure;
    else major = resolvedMajor.success;
  }
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
        local: artifact.version,
        remote: remoteName === undefined ? "" : (remote[remoteName] ?? ""),
      } satisfies ServiceVersionRow;
    }),
  ).pipe(Effect.map((rows) => ({ rows, configError })));
});
