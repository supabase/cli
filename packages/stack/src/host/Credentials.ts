import { Data, Effect, Redacted, Schema } from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "../Defaults.ts";
import { ServiceCreation, type ServiceCreationInput } from "../services/Catalog.ts";
import { resolveStackKeys } from "../services/ServiceConfig.ts";
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

const credentialsChanged = (saved: StackCredentials, next: StackCredentials) =>
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
  keys: StackIdentityInput | undefined,
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
      ...(yield* resolveStackKeys(jwtSecret, keys, undefined)),
    } satisfies StackCredentials;
  }
  const conflict =
    (overrides.postgresRootKey !== undefined &&
      overrides.postgresRootKey !== saved.postgresRootKey &&
      "rootKey") ||
    (overrides.databasePassword !== undefined &&
      overrides.databasePassword !== saved.databasePassword &&
      "databasePassword") ||
    (keys === undefined &&
      overrides.jwtSecret !== undefined &&
      overrides.jwtSecret !== saved.jwtSecret &&
      "jwtSecret");
  if (conflict !== false)
    return yield* new CredentialError({
      message: `Credential override ${conflict} conflicts with the saved stack value`,
    });
  const jwtSecret =
    keys === undefined ? saved.jwtSecret : (overrides.jwtSecret ?? DEFAULT_LOCAL_JWT_SECRET);
  const next: StackCredentials = {
    ...saved,
    jwtSecret,
    ...(yield* resolveStackKeys(jwtSecret, keys, saved)),
  };
  return credentialsChanged(saved, next) ? next : saved;
});

type CredentialValue = {
  [K in keyof StackCredentials]: StackCredentials[K] extends string ? K : never;
}[keyof StackCredentials];

/** Config inputs each service receives from the stack credential record, by input name. */
const credentialInputs: {
  readonly [K in ServiceCreation["service"]]: Readonly<Record<string, CredentialValue>>;
} = {
  database: {
    databasePassword: "databasePassword",
    jwtSecret: "jwtSecret",
    rootKey: "postgresRootKey",
  },
  rest: { jwtSecret: "jwtSecret", jwks: "jwks" },
  auth: { jwtSecret: "jwtSecret", gotrueJwtKeys: "gotrueJwtKeys" },
  realtime: { jwtSecret: "jwtSecret", jwks: "jwks" },
  storage: {
    jwtSecret: "jwtSecret",
    jwks: "jwks",
    anonKey: "anonKey",
    serviceRoleKey: "serviceRoleKey",
  },
  functions: {
    jwtSecret: "jwtSecret",
    jwks: "jwks",
    anonKey: "anonKey",
    serviceRoleKey: "serviceRoleKey",
    publishableKey: "publishableKey",
    secretKey: "secretKey",
  },
  studio: {
    jwtSecret: "jwtSecret",
    anonKey: "anonKey",
    serviceRoleKey: "serviceRoleKey",
    publishableKey: "publishableKey",
    secretKey: "secretKey",
  },
  pooler: { jwtSecret: "jwtSecret" },
  imgproxy: {},
  pgmeta: {},
  mail: {},
  analytics: {},
  vector: {},
};

/** Names the config inputs the owner fills from the stack credential record. */
export const credentialInputNames = (service: ServiceCreation["service"]): ReadonlyArray<string> =>
  Object.keys(credentialInputs[service]);

/**
 * Completes a creation with the stack credentials it consumes. The JWT secret and database
 * credentials always come from the record; other inputs keep an explicit value.
 */
export const withCredentials = (
  creation: ServiceCreationInput,
  credentials: StackCredentials,
): Effect.Effect<ServiceCreation, Schema.SchemaError> => {
  const config: Record<string, unknown> = { ...creation.config };
  for (const [input, source] of Object.entries(credentialInputs[creation.service])) {
    const value = credentials[source];
    if (creation.service === "database") config[input] = Redacted.make(value);
    else if (input === "jwtSecret" || config[input] === undefined) config[input] = value;
  }
  return Schema.decodeUnknownEffect(ServiceCreation)({ ...creation, config });
};
