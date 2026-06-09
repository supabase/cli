import { Context, type Effect } from "effect";
import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "../config/legacy-project-ref.errors.ts";
import type { LegacyManagementApiRuntimeError } from "./legacy-management-api-runtime.layer.ts";
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
  | LegacyDbConnectError;

// The `--linked` path builds the Management API stack lazily (so `--local` /
// `--db-url` never resolve an access token) and provides ALL of its own
// requirements from the resolver's captured context, so `resolve`'s R stays
// `never`. The stack's build error (access-token resolution) does surface here —
// `test db --linked` without a token fails with that error, matching Go. We
// reference the runtime layer's own named error type rather than re-deriving it
// structurally, keeping this contract decoupled from the layer's internals.
interface LegacyDbConfigResolverShape {
  readonly resolve: (
    flags: LegacyDbConfigFlags,
  ) => Effect.Effect<LegacyResolvedDbConfig, LegacyDbConfigError | LegacyManagementApiRuntimeError>;
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
