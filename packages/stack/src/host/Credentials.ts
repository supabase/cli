import { Data, Effect, Redacted, Schema } from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "../Defaults.ts";
import { ServiceCreation, type ServiceCreationInput } from "../services/Catalog.ts";
import { resolveStackIdentity } from "../services/ServiceConfig.ts";
import type { SavedStack, StackCredentials, StackIdentityInput } from "../State.ts";

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly message: string;
}> {}

type Overrides = Partial<
  Pick<StackCredentials, "jwtSecret" | "postgresRootKey" | "databasePassword">
>;

/** Reports whether a creation receives the stack-wide credential record. */
export const consumesCredentials = (creation: ServiceCreationInput): boolean => {
  switch (creation.service) {
    case "database":
    case "auth":
    case "realtime":
    case "storage":
    case "functions":
    case "studio":
    case "pooler":
      return true;
    case "rest":
      return creation.config.jwks === undefined || creation.config.jwtSecret !== undefined;
    default:
      return false;
  }
};

const overridesFor = (creation: ServiceCreationInput): Overrides => {
  if (creation.service === "database")
    return {
      ...(creation.config.jwtSecret === undefined
        ? {}
        : { jwtSecret: Redacted.value(creation.config.jwtSecret) }),
      ...(creation.config.rootKey === undefined
        ? {}
        : { postgresRootKey: Redacted.value(creation.config.rootKey) }),
      ...(creation.config.databasePassword === undefined
        ? {}
        : { databasePassword: Redacted.value(creation.config.databasePassword) }),
    };
  return "jwtSecret" in creation.config && creation.config.jwtSecret !== undefined
    ? { jwtSecret: creation.config.jwtSecret }
    : {};
};

/** Collects explicit credential values, rejecting creations that disagree with each other. */
export const credentialOverrides = (
  creations: ReadonlyArray<ServiceCreationInput>,
): Effect.Effect<Overrides, CredentialError> => {
  const overrides: Record<string, string> = {};
  for (const creation of creations)
    for (const [key, value] of Object.entries(overridesFor(creation))) {
      if (overrides[key] !== undefined && overrides[key] !== value)
        return Effect.fail(
          new CredentialError({
            message: `Credential override ${key} conflicts within the stack composition`,
          }),
        );
      overrides[key] = value;
    }
  return Effect.succeed(overrides);
};

/** Drops the stack credential record once no saved instance consumes it. */
export const withoutUnusedCredentials = (saved: SavedStack): SavedStack => {
  if (
    saved.credentials === undefined ||
    saved.instances.some(({ creation }) => consumesCredentials(creation))
  )
    return saved;
  const withoutCredentials = { ...saved };
  delete withoutCredentials.credentials;
  return withoutCredentials;
};

const identityChanged = (saved: StackCredentials, next: StackCredentials) =>
  next.jwtSecret !== saved.jwtSecret ||
  next.publishableKey !== saved.publishableKey ||
  next.secretKey !== saved.secretKey ||
  next.anonKey !== saved.anonKey ||
  next.serviceRoleKey !== saved.serviceRoleKey ||
  next.jwks !== saved.jwks ||
  next.gotrueJwtKeys !== saved.gotrueJwtKeys ||
  next.remoteJwks !== saved.remoteJwks ||
  next.anonKeyIsOverride !== saved.anonKeyIsOverride ||
  next.serviceRoleKeyIsOverride !== saved.serviceRoleKeyIsOverride;

/**
 * Resolves the stack credential record, generating one only while no saved instance consumes it;
 * it returns the saved record itself when nothing changes.
 */
export const nextCredentials = Effect.fn("Credentials.next")(function* (
  current: Pick<SavedStack, "credentials" | "instances">,
  overrides: Overrides,
  identity: StackIdentityInput | undefined,
) {
  const saved = current.credentials;
  if (saved === undefined) {
    if (current.instances.some(({ creation }) => consumesCredentials(creation)))
      return yield* new CredentialError({
        message: "Saved instances have no stack credential record; refusing to infer credentials",
      });
    const jwtSecret = overrides.jwtSecret ?? DEFAULT_LOCAL_JWT_SECRET;
    return {
      jwtSecret,
      postgresRootKey: overrides.postgresRootKey ?? DEFAULT_POSTGRES_ROOT_KEY,
      databasePassword: overrides.databasePassword ?? DEFAULT_LOCAL_DATABASE_PASSWORD,
      ...(yield* resolveStackIdentity(jwtSecret, identity, undefined)),
    } satisfies StackCredentials;
  }
  const conflict =
    (overrides.postgresRootKey !== undefined &&
      overrides.postgresRootKey !== saved.postgresRootKey &&
      "rootKey") ||
    (overrides.databasePassword !== undefined &&
      overrides.databasePassword !== saved.databasePassword &&
      "databasePassword") ||
    (identity === undefined &&
      overrides.jwtSecret !== undefined &&
      overrides.jwtSecret !== saved.jwtSecret &&
      "jwtSecret");
  if (conflict !== false)
    return yield* new CredentialError({
      message: `Credential override ${conflict} conflicts with the saved stack value`,
    });
  const jwtSecret =
    identity === undefined ? saved.jwtSecret : (overrides.jwtSecret ?? DEFAULT_LOCAL_JWT_SECRET);
  const next: StackCredentials = {
    ...saved,
    jwtSecret,
    ...(yield* resolveStackIdentity(jwtSecret, identity, saved)),
  };
  return identityChanged(saved, next) ? next : saved;
});

/** Completes a creation with the stack credentials it consumes. */
export const withCredentials = (
  creation: ServiceCreationInput,
  credentials: StackCredentials,
): Effect.Effect<ServiceCreation, Schema.SchemaError> => {
  const config: Record<string, unknown> = { ...creation.config };
  switch (creation.service) {
    case "database":
      Object.assign(config, {
        databasePassword: Redacted.make(credentials.databasePassword),
        jwtSecret: Redacted.make(credentials.jwtSecret),
        rootKey: Redacted.make(credentials.postgresRootKey),
      });
      break;
    case "auth":
      Object.assign(config, {
        jwtSecret: credentials.jwtSecret,
        gotrueJwtKeys: creation.config.gotrueJwtKeys ?? credentials.gotrueJwtKeys,
      });
      break;
    case "rest":
    case "realtime":
      Object.assign(config, {
        jwtSecret: credentials.jwtSecret,
        jwks: creation.config.jwks ?? credentials.jwks,
      });
      break;
    case "storage":
      Object.assign(config, {
        jwtSecret: credentials.jwtSecret,
        jwks: creation.config.jwks ?? credentials.jwks,
        anonKey: creation.config.anonKey ?? credentials.anonKey,
        serviceRoleKey: creation.config.serviceRoleKey ?? credentials.serviceRoleKey,
      });
      break;
    case "functions":
      Object.assign(config, {
        jwtSecret: credentials.jwtSecret,
        jwks: creation.config.jwks ?? credentials.jwks,
        anonKey: creation.config.anonKey ?? credentials.anonKey,
        serviceRoleKey: creation.config.serviceRoleKey ?? credentials.serviceRoleKey,
        publishableKey: creation.config.publishableKey ?? credentials.publishableKey,
        secretKey: creation.config.secretKey ?? credentials.secretKey,
      });
      break;
    case "studio":
      Object.assign(config, {
        jwtSecret: credentials.jwtSecret,
        anonKey: creation.config.anonKey ?? credentials.anonKey,
        serviceRoleKey: creation.config.serviceRoleKey ?? credentials.serviceRoleKey,
        publishableKey: creation.config.publishableKey ?? credentials.publishableKey,
        secretKey: creation.config.secretKey ?? credentials.secretKey,
      });
      break;
    default:
      Object.assign(config, { jwtSecret: credentials.jwtSecret });
  }
  return Schema.decodeUnknownEffect(ServiceCreation)({ ...creation, config });
};
