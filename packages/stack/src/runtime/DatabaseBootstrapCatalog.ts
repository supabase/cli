import { Effect, Redacted } from "effect";
import type { DatabaseBootstrapOptions } from "../model/DatabaseBootstrap.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { AUTH_JWT_SECRET_SLOT, DATABASE_INTERNAL_PASSWORD_SLOT } from "../state/SecretStore.ts";

/**
 * The only SQL revision owned by the runtime bootstrap. The slim Postgres
 * artifact owns its bundled init scripts and migrations; this revision only
 * reconciles the schema ownership that used to be applied by the CLI.
 */
export const DATABASE_BOOTSTRAP_REVISION = {
  id: "database-realtime-schema-owner",
  statement: "CREATE SCHEMA IF NOT EXISTS _realtime;\nALTER SCHEMA _realtime OWNER TO postgres;",
} as const;

const missingMaterial = (message: string) => new StackPreparationError({ message });

const secretValue = (state: PersistedStackState, slot: string): string | undefined => {
  const value = state.secrets[slot]?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Builds the initial database bootstrap from fully materialized state.
 *
 * This helper intentionally does not read artifact SQL files or perform
 * caller-driven reset/migration/seed work. It returns only the closed role
 * credentials, database settings, and one idempotent `_realtime` revision.
 */
export const databaseBootstrapPlan = (
  state: PersistedStackState,
): Effect.Effect<DatabaseBootstrapOptions, StackPreparationError> =>
  Effect.gen(function* () {
    if (state.definition === undefined)
      return yield* missingMaterial(
        "A materialized stack definition is required for database bootstrap",
      );

    const databasePassword = secretValue(state, DATABASE_INTERNAL_PASSWORD_SLOT);
    if (databasePassword === undefined)
      return yield* missingMaterial("Managed database password is unavailable for bootstrap");

    const jwtSecret = secretValue(state, AUTH_JWT_SECRET_SLOT);
    if (jwtSecret === undefined)
      return yield* missingMaterial("Managed JWT secret is unavailable for database bootstrap");

    const jwtExpiry = state.definition.capabilities.auth.settings.jwt_expiry;
    if (
      typeof jwtExpiry !== "number" ||
      !Number.isFinite(jwtExpiry) ||
      !Number.isInteger(jwtExpiry) ||
      jwtExpiry <= 0
    )
      return yield* missingMaterial("Auth JWT expiry must be a finite positive integer");

    const password = Redacted.make(databasePassword);
    return {
      revisions: [DATABASE_BOOTSTRAP_REVISION],
      credentials: {
        roles: {
          postgres: password,
          authenticator: password,
          pgbouncer: password,
          supabase_auth_admin: password,
          supabase_storage_admin: password,
          supabase_replication_admin: password,
          supabase_read_only_user: password,
        },
      },
      settings: {
        jwtSecret: Redacted.make(jwtSecret),
        jwtExpiry,
      },
    } satisfies DatabaseBootstrapOptions;
  });
