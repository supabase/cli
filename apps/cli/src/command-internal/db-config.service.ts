import { Context, Config, type Effect, type Option } from "effect";
import type { SupabaseApiInputError } from "@supabase/api/effect";
import type * as HttpBody from "effect/http/HttpBody";
import type { CommandPlatformApiFactoryError } from "../auth/command-platform-api-factory.service.ts";
import type { PgConnInput } from "./db-connection.service.ts";
import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
} from "../config/project-ref.errors.ts";
import type { ProfileLoadError } from "./profile-load.ts";
import type { ProjectRefReadError } from "../shared/config/temp-paths.ts";
import type { DbConnectError } from "./db-connection.errors.ts";
import type { LocalDbRunningError } from "./db-bootstrap/local-db-running.ts";
import type {
  DbConfigConnectTempRoleError,
  DbConfigIpv6Error,
  DbConfigListBansNetworkError,
  DbConfigListBansStatusError,
  DbConfigLoadError,
  DbConfigLoginRoleNetworkError,
  DbConfigLoginRoleStatusError,
  DbConfigParseUrlError,
  DbConfigPoolerLoginError,
  DbConfigUnbanNetworkError,
  DbConfigUnbanStatusError,
  LinkedDbNetworkBannedError,
} from "./db-config.errors.ts";
import type { DbConnectionInput, ResolvedDbConnection } from "./db-config.types.ts";
import type {
  CliConfigFlagConflictError,
  CliConfigValueError,
} from "../config/cli-config.errors.ts";
import type { TargetPasswordConflictError } from "./target/target.errors.ts";

/** Every error the resolver can raise across the direct / local / linked paths. */
export type DbConfigError =
  | Config.ConfigError
  | DbConfigParseUrlError
  | DbConfigLoadError
  | CliConfigValueError
  | CliConfigFlagConflictError
  | LocalDbRunningError
  | ProjectRefNotLinkedError
  | InvalidProjectRefError
  // A hard linked-ref load surfaces a real `.temp/project-ref` read error instead of masking it
  // as not-linked.
  | ProjectRefReadError
  | DbConfigLoginRoleNetworkError
  | DbConfigLoginRoleStatusError
  | DbConfigListBansNetworkError
  | DbConfigListBansStatusError
  | DbConfigUnbanNetworkError
  | DbConfigUnbanStatusError
  | SupabaseApiInputError
  | HttpBody.HttpBodyError
  | DbConfigIpv6Error
  | DbConfigConnectTempRoleError
  | LinkedDbNetworkBannedError
  | TargetPasswordConflictError
  | DbConfigPoolerLoginError
  | DbConnectError
  // The `--linked` path resolves the access token lazily via
  // `CommandPlatformApiFactory.make` (when minting a temp login role), so the
  // auth-required / invalid-token / api-config errors surface from the resolver effect — not a
  // layer-build channel. `--linked --password` never raises these: a failed `make` only skips
  // the pooler-config fallback.
  | CommandPlatformApiFactoryError
  // The lazy linked runtime rebuilds `commandSettingsLayer`, whose strict
  // profile resolution can fail inside the resolver effect the same way.
  | ProfileLoadError;

// The `--linked` path builds a lazy Management API runtime (so `--local`/`--db-url` never need an
// access token) from the resolver's captured context, so `resolve`'s R stays `never` and the
// auth-required error surfaces through the resolver effect, not a layer-build error channel.
interface DbConfigResolverShape {
  /** Connects to a resolved target (local, `--db-url` or the linked temp role) and announces it. */
  readonly resolveConnection: (
    input: DbConnectionInput,
  ) => Effect.Effect<ResolvedDbConnection, DbConfigError>;
  /**
   * Resolves the IPv4 transaction pooler connection for a linked dump's container-level
   * fallback. Returns `None` when the target is not the linked project or no pooler URL is
   * configured, so the caller keeps the original error.
   */
  readonly resolvePoolerFallback: (
    input: DbConnectionInput,
  ) => Effect.Effect<Option.Option<PgConnInput>, DbConfigError>;
}

/** Resolves a Postgres connection for a resolved `local`, `db-url` or `linked` target. */
export class DbConfigResolver extends Context.Service<DbConfigResolver, DbConfigResolverShape>()(
  "supabase/cli/DbConfigResolver",
) {}
