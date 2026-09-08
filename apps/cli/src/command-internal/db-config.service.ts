import { Context, type Effect, type Option } from "effect";
import type { SupabaseApiInputError } from "@supabase/api/effect";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import type { CommandPlatformApiFactoryError } from "../auth/command-platform-api-factory.service.ts";
import type { PgConnInput } from "./db-connection.service.ts";
import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
} from "../config/project-ref.errors.ts";
import type { ProfileLoadError } from "./profile-load.ts";
import type { ProjectRefReadError } from "./temp-paths.ts";
import type { DbConnectError } from "./db-connection.errors.ts";
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
} from "./db-config.errors.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "./db-config.types.ts";

/** Every error the resolver can raise across the direct / local / linked paths. */
export type DbConfigError =
  | DbConfigParseUrlError
  | DbConfigLoadError
  | ProjectRefNotLinkedError
  | InvalidProjectRefError
  // Hard linked-ref load surfaces a real `.temp/project-ref` read error (Go's
  // `failed to load project ref`) instead of masking it as not-linked.
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
  | DbConfigPoolerLoginError
  | DbConnectError
  // The `--linked` path resolves the access token lazily via
  // `CommandPlatformApiFactory.make` (only when minting a temp login role), so the
  // auth-required / invalid-token / api-config errors surface from the resolver
  // effect — not a layer-build channel. `--linked --password` skips `make`
  // entirely and never raises these (`NewDbConfigWithPassword`).
  | CommandPlatformApiFactoryError
  // The lazy linked runtime rebuilds `commandSettingsLayer`, whose strict
  // profile resolution can fail inside the resolver effect the same way.
  | ProfileLoadError;

// The `--linked` path builds a lazy Management API runtime (so `--local` /
// `--db-url` never resolve an access token) and provides ALL of its own
// requirements from the resolver's captured context, so `resolve`'s R stays
// `never`. Access-token resolution is deferred to first API use, so its
// auth-required error surfaces through the resolver effect (folded into
// `DbConfigError`) rather than a layer-build error channel.
interface DbConfigResolverShape {
  readonly resolve: (flags: DbConfigFlags) => Effect.Effect<ResolvedDbConfig, DbConfigError>;
  /**
   * Resolves the IPv4 transaction pooler connection for a linked dump's
   * container-level fallback (`RunWithPoolerFallback` →
   * `ResolvePoolerConfigForFallback`). Returns `None` when the path is not
   * pooler-eligible (`--linked` only) or no pooler URL is configured, so the
   * caller keeps the original error.
   */
  readonly resolvePoolerFallback: (
    flags: DbConfigFlags,
  ) => Effect.Effect<Option.Option<PgConnInput>, DbConfigError>;
}

/**
 * Resolves a Postgres connection from the `--db-url` / `--local` / `--linked`
 * flags. Shared cross-command infra:
 * `db reset` / `db dump` will reuse it as they are ported.
 */
export class DbConfigResolver extends Context.Service<DbConfigResolver, DbConfigResolverShape>()(
  "supabase/cli/DbConfigResolver",
) {}
