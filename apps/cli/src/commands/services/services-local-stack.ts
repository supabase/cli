import { artifactServiceKinds, type ArtifactSelection } from "@supabase/stack/internal/artifacts";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { Effect, Result } from "effect";
import { isConfigValueFailure } from "../../command-internal/config-value-passthrough.ts";
import {
  describeConfigLoadFailure,
  loadResolvedConfigContext,
} from "../../command-internal/resolved-config-context.ts";
import { stackArtifactSelection } from "../../command-internal/stack-artifact-selection.ts";
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
  const context = yield* loadResolvedConfigContext(workdir).pipe(Effect.result);
  let configError: string | undefined;
  let selection: ArtifactSelection = defaultArtifactSelection();
  if (Result.isFailure(context)) {
    if (isConfigValueFailure(context.failure)) return yield* context.failure;
    configError = describeConfigLoadFailure(context.failure);
  } else {
    const { db } = context.success.config;
    if (db.major_version !== 15 && db.major_version !== 17) {
      configError = `unsupported PostgreSQL major version: ${db.major_version}`;
    } else {
      // A listing never resolves: it shows the locked pins, else the bundled ones.
      const resolved = yield* readSelectionOrBundled({
        projectRoot: workdir,
        majorVersion: db.major_version,
        orioledbVersion: db.orioledb_version,
        services: context.success.config.local?.services,
      }).pipe(
        Effect.catchTag("LockResolutionError", (error) =>
          Effect.sync(() => {
            configError = error.message;
          }).pipe(Effect.andThen(stackArtifactSelection(db))),
        ),
        Effect.result,
      );
      if (Result.isFailure(resolved)) configError = resolved.failure.message;
      else selection = resolved.success;
    }
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
