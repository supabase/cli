import { Context, type Effect } from "effect";
import type { LegacyPlatformApiFactoryError } from "../auth/legacy-platform-api-factory.service.ts";
import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "../config/legacy-project-ref.errors.ts";
import type { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";
import type {
  LegacyDbConfigConnectTempRoleError,
  LegacyDbConfigIpv6Error,
  LegacyDbConfigListBansNetworkError,
  LegacyDbConfigListBansStatusError,
  LegacyDbConfigLoadError,
  LegacyDbConfigLoginRoleNetworkError,
  LegacyDbConfigLoginRoleStatusError,
  LegacyDbConfigParseUrlError,
  LegacyDbConfigPoolerLoginError,
  LegacyDbConfigUnbanNetworkError,
  LegacyDbConfigUnbanStatusError,
} from "./legacy-db-config.errors.ts";
import type { LegacyDbConfigFlags, LegacyResolvedDbConfig } from "./legacy-db-config.types.ts";

/** Every error the resolver can raise across the direct / local / linked paths. */
export type LegacyDbConfigError =
  | LegacyDbConfigParseUrlError
  | LegacyDbConfigLoadError
  | LegacyProjectNotLinkedError
  | LegacyInvalidProjectRefError
  | LegacyDbConfigLoginRoleNetworkError
  | LegacyDbConfigLoginRoleStatusError
  | LegacyDbConfigListBansNetworkError
  | LegacyDbConfigListBansStatusError
  | LegacyDbConfigUnbanNetworkError
  | LegacyDbConfigUnbanStatusError
  | LegacyDbConfigIpv6Error
  | LegacyDbConfigConnectTempRoleError
  | LegacyDbConfigPoolerLoginError
  | LegacyDbConnectError
  // The `--linked` path resolves the access token lazily via
  // `LegacyPlatformApiFactory.make` (only when minting a temp login role), so the
  // auth-required / invalid-token / api-config errors surface from the resolver
  // effect — not a layer-build channel. `--linked --password` skips `make`
  // entirely and never raises these (Go's `NewDbConfigWithPassword`).
  | LegacyPlatformApiFactoryError;

// The `--linked` path builds a lazy Management API runtime (so `--local` /
// `--db-url` never resolve an access token) and provides ALL of its own
// requirements from the resolver's captured context, so `resolve`'s R stays
// `never`. Access-token resolution is deferred to first API use, so its
// auth-required error surfaces through the resolver effect (folded into
// `LegacyDbConfigError`) rather than a layer-build error channel.
interface LegacyDbConfigResolverShape {
  readonly resolve: (
    flags: LegacyDbConfigFlags,
  ) => Effect.Effect<LegacyResolvedDbConfig, LegacyDbConfigError>;
}

/**
 * Resolves a Postgres connection from the `--db-url` / `--local` / `--linked`
 * flags, porting Go's `flags.ParseDatabaseConfig` + `NewDbConfigWithPassword`
 * (`apps/cli-go/internal/utils/flags/db_url.go`). Shared cross-command infra:
 * `db reset` / `db dump` will reuse it as they are ported.
 */
export class LegacyDbConfigResolver extends Context.Service<
  LegacyDbConfigResolver,
  LegacyDbConfigResolverShape
>()("supabase/legacy/DbConfigResolver") {}
