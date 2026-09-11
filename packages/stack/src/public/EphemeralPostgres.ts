import { Crypto, Effect, FileSystem, Path, Redacted, Scope } from "effect";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { DatabaseModule } from "../model/capabilities/database.ts";
import { catalogReleaseFor } from "../model/WorkloadCatalog.ts";
import { createEphemeralPostgresCluster } from "../runtime/EphemeralPostgres.ts";
import type { EphemeralPostgresCreateError, EphemeralPostgresError } from "./Errors.ts";
import { StackVersionUnsupportedError } from "./Errors.ts";
import type { StackRuntime, StackRuntimePreference } from "./Runtime.ts";

export interface EphemeralPostgresSettings {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface CreateEphemeralPostgresOptions {
  /** Omitted preference uses Docker when installed, otherwise native. */
  readonly runtime?: StackRuntimePreference;
  /** Exact catalog release or major selector such as `"17"`. */
  readonly version?: string;
  readonly port?: number;
  readonly databasePassword: Redacted.Redacted<string>;
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly jwtExpiry?: number;
  readonly postgresSettings?: EphemeralPostgresSettings;
  readonly healthTimeout?: string;
  /** Stopped-cluster PGDATA tar to restore before the first start. */
  readonly restoreFrom?: string;
}

export interface EphemeralPostgresRelease {
  readonly version: string;
  readonly image: string;
}

export type EphemeralPostgresServices =
  | ChildProcessSpawnerService
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path;

export interface EffectEphemeralPostgres {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly runtime: StackRuntime;
  /** Catalog identity hashed into CLI shadow-cache keys. */
  readonly artifactIdentity: string;
  readonly url: Redacted.Redacted<string>;
  readonly start: Effect.Effect<void, EphemeralPostgresError, EphemeralPostgresServices>;
  readonly stop: Effect.Effect<void, EphemeralPostgresError>;
  readonly exportPgData: (
    tarPath: string,
  ) => Effect.Effect<void, EphemeralPostgresError, EphemeralPostgresServices>;
}

/** Resolves a Postgres catalog release the same way stack compilation does. */
export const resolveEphemeralPostgresRelease = (
  version?: string,
): Effect.Effect<EphemeralPostgresRelease, StackVersionUnsupportedError> => {
  const requested = version ?? DatabaseModule.defaultVersion;
  const selected = DatabaseModule.releases[requested];
  const release =
    selected === undefined
      ? catalogReleaseFor("database:database", requested)
      : catalogReleaseFor("database:database", selected.version);
  if (release === undefined)
    return Effect.fail(
      new StackVersionUnsupportedError({
        message: `Unsupported PostgreSQL version ${requested}`,
        version: requested,
        capability: "database",
      }),
    );
  return Effect.succeed({ version: release.version, image: release.containerImage });
};

export const createEphemeralPostgres = (
  options: CreateEphemeralPostgresOptions,
): Effect.Effect<
  EffectEphemeralPostgres,
  EphemeralPostgresCreateError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> => createEphemeralPostgresCluster(options);
