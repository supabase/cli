import { artifactServiceKinds, type ArtifactSelection } from "@supabase/stack/internal/artifacts";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { Effect, Result } from "effect";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import {
  envOverrideMajorVersion,
  envOverrideOrioleDBVersion,
} from "../../command-internal/local-config-values.ts";
import { stackArtifactSelection } from "../../command-internal/stack-artifact-selection.ts";
import { StackConfigError } from "../../command-internal/stack-config.ts";
import { readSelectionOrBundled } from "../../command-internal/stack-lock.ts";
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
  let selection: ArtifactSelection = defaultArtifactSelection();
  if (Result.isFailure(context)) configError = context.failure;
  else {
    const resolved = yield* Effect.try({
      try: () => {
        const value = envOverrideMajorVersion(
          context.success.config.db.major_version,
          context.success.projectEnvValues,
        );
        if (value !== 15 && value !== 17)
          throw new Error(`unsupported PostgreSQL major version: ${value}`);
        const db = {
          major_version: value,
          orioledb_version: envOverrideOrioleDBVersion(
            context.success.config.db.orioledb_version,
            context.success.projectEnvValues,
          ),
        };
        // A listing never resolves: it shows the locked pins, else the bundled ones.
        return readSelectionOrBundled({
          projectRoot: workdir,
          majorVersion: db.major_version,
          orioledbVersion: db.orioledb_version,
          services: context.success.config.local?.services,
        }).pipe(
          Effect.catchTag("LockResolutionError", (error) =>
            Effect.sync(() => {
              configError = error.message;
            }).pipe(
              Effect.andThen(stackArtifactSelection(db)),
              Effect.mapError((cause) => new StackConfigError({ message: cause.message })),
            ),
          ),
        );
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.flatMap((selected) => Effect.mapError(selected, (error) => error.message)),
      Effect.result,
    );
    if (Result.isFailure(resolved)) configError = resolved.failure;
    else selection = resolved.success;
  }
  yield* Effect.annotateCurrentSpan({ "config.load_failed": configError !== undefined });
  const rows = artifactServiceKinds().map((service) => {
    const pin = selection[service];
    const name = pin.image.split("@")[0]?.replace(/:[^/:]+$/, "") ?? pin.image;
    const remoteName = remoteNames[service];
    return {
      name,
      local: pin.upstreamVersion,
      remote: remoteName === undefined ? "" : (remote[remoteName] ?? ""),
    } satisfies ServiceVersionRow;
  });
  return { rows, configError };
});
