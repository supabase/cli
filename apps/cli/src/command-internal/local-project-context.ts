import type { CliConfig } from "@supabase/config";
import { Crypto, Effect, FileSystem, Option, Path } from "effect";

import { CliConfigValues, type CliConfigSnapshot } from "../config/cli-config-values.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import {
  describeConfigSnapshotFailure,
  loadLocalSnapshotContext,
} from "./config-snapshot-context.ts";
import { recordOrioleDbTelemetry } from "./db-image.ts";

/** Effective config, project env file values, hostname, and sanitized project id for a command. */
export interface LocalProjectContext {
  /** The decoded config with every override, default and normalizer applied. */
  readonly config: CliConfig;
  /** Values from `supabase/.env*` files only; a name the shell sets is never in here. */
  readonly projectEnvValues: Readonly<Record<string, string>>;
  readonly snapshot: CliConfigSnapshot;
  readonly hostname: string;
  /** The project id sanitized for Docker resource names. */
  readonly projectId: string;
}

export const loadLocalProjectContext = <E>(
  workdir: string,
  mapConfigLoadError: (message: string) => E,
  // An already-resolved `--linked`/`--project-ref` value, when the caller has one; it selects
  // the matching `[remotes.<ref>]` block. `undefined` applies no remote.
  projectRef?: string,
): Effect.Effect<
  LocalProjectContext,
  E,
  FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto | CliConfigValues
> =>
  Effect.gen(function* () {
    const { snapshot, config, projectEnvValues, hostname, projectId } =
      yield* loadLocalSnapshotContext(workdir, Option.fromNullishOr(projectRef)).pipe(
        Effect.mapError((cause) => mapConfigLoadError(describeConfigSnapshotFailure(cause))),
      );
    const appliedRemote = Option.getOrUndefined(snapshot.appliedRemote);

    yield* Effect.annotateCurrentSpan({
      "config.remote_applied": appliedRemote !== undefined,
    });
    return {
      config,
      projectEnvValues,
      snapshot,
      hostname,
      projectId,
    };
  }).pipe(Effect.withSpan("LocalProjectContext.load"));

/** Records OrioleDB selection for commands whose only local config read is this context. */
export const recordLocalProjectOrioleDbTelemetry = (context: LocalProjectContext) =>
  recordOrioleDbTelemetry(context.config.db.orioledb_version, context.config.db.major_version).pipe(
    Effect.ignore,
  );
