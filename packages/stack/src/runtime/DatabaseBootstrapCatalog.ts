import { Effect, Redacted } from "effect";
import type { DatabaseBootstrapOptions } from "../model/DatabaseBootstrap.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";

const missingMaterial = (message: string) => new StackPreparationError({ message });

const secretValue = (state: PersistedStackState, slot: string): string | undefined => {
  const value = state.secrets[slot]?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Builds the initial database bootstrap from fully materialized state.
 *
 * Returns only the managed material the fixed runtime bootstrap reconciliation needs; it does
 * not read artifact SQL files or perform caller-driven reset/migration/seed work.
 */
export const databaseBootstrapPlan = (
  state: PersistedStackState,
  instance: PersistedServiceInstance,
): Effect.Effect<DatabaseBootstrapOptions, StackPreparationError> =>
  Effect.gen(function* () {
    if (instance.service !== "database")
      return yield* missingMaterial("Database bootstrap requires a database instance");
    const databasePasswordSlot = instance.config.passwordSecretRef;
    if (databasePasswordSlot === undefined)
      return yield* missingMaterial("Database instance password secret is unavailable");
    const databasePassword = secretValue(state, databasePasswordSlot);
    if (databasePassword === undefined)
      return yield* missingMaterial("Managed database password is unavailable for bootstrap");

    const signing = state.security.jwt?.signing;
    const jwtSecretSlot =
      signing?.kind === "symmetric" ? signing.secret.slot : AUTH_JWT_SECRET_SLOT;
    const jwtSecret = secretValue(state, jwtSecretSlot);
    if (jwtSecret === undefined)
      return yield* missingMaterial("Managed JWT secret is unavailable for database bootstrap");

    const jwtExpiryValue = String(state.security.jwt?.expirySeconds ?? "");
    const jwtExpiry = Number(jwtExpiryValue);
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
