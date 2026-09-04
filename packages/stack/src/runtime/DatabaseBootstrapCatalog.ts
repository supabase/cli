import { Effect, Redacted } from "effect";
import type { DatabaseBootstrapOptions } from "../model/DatabaseBootstrap.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { AUTH_JWT_SECRET_SLOT, DATABASE_INTERNAL_PASSWORD_SLOT } from "../state/SecretStore.ts";

const missingMaterial = (message: string) => new StackPreparationError({ message });

const secretValue = (state: PersistedStackState, slot: string): string | undefined => {
  const value = state.secrets[slot]?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Builds the initial database bootstrap from fully materialized state.
 *
 * This helper intentionally does not read artifact SQL files or perform
 * caller-driven reset/migration/seed work. It returns only the managed
 * material required by the fixed runtime bootstrap reconciliation.
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

    return {
      databasePassword: Redacted.make(databasePassword),
      jwtSecret: Redacted.make(jwtSecret),
      jwtExpiry,
    } satisfies DatabaseBootstrapOptions;
  });
