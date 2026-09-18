import { Effect, Redacted } from "effect";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type { ServiceCredentials } from "../public/Service.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { StackError } from "../public/Errors.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
} from "../state/SecretStore.ts";

const secret = (state: PersistedStackState, slot: string): string | undefined =>
  state.secrets[slot]?.value;

const apiCredentials = (
  state: PersistedStackState,
):
  | {
      readonly publishableKey: string;
      readonly secretKey: string;
      readonly anonJwt: string;
      readonly serviceRoleJwt: string;
    }
  | undefined => {
  if (state.listeners.api?.enabled !== true) return undefined;
  const publishableKey = secret(state, AUTH_PUBLISHABLE_KEY_SLOT);
  const secretKey = secret(state, AUTH_SECRET_KEY_SLOT);
  const anonJwt = secret(state, AUTH_ANON_KEY_SLOT);
  const serviceRoleJwt = secret(state, AUTH_SERVICE_ROLE_KEY_SLOT);
  return publishableKey === undefined ||
    secretKey === undefined ||
    anonJwt === undefined ||
    serviceRoleJwt === undefined
    ? undefined
    : { publishableKey, secretKey, anonJwt, serviceRoleJwt };
};

const databaseCredentials = (
  state: PersistedStackState,
  instance: PersistedServiceInstance | undefined,
): { readonly url: string; readonly password: string } | undefined => {
  if (instance?.service !== "database" || !instance.config.enabled) return undefined;
  const passwordRef = instance.config.passwordSecretRef;
  const password = passwordRef === undefined ? undefined : secret(state, passwordRef);
  const sql = state.ports.find(
    (assignment) =>
      assignment.owner === "instance" &&
      assignment.instanceId === instance.id &&
      assignment.binding === "sql",
  );
  return password === undefined || sql === undefined
    ? undefined
    : {
        url: `postgresql://postgres:${encodeURIComponent(password)}@${sql.address}:${sql.port}/postgres`,
        password,
      };
};

const storageCredentials = (
  state: PersistedStackState,
  instance: PersistedServiceInstance | undefined,
):
  | {
      readonly endpoint: string;
      readonly region: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    }
  | undefined => {
  if (instance?.service !== "storage" || !instance.config.enabled) return undefined;
  const protocol = instance.config.settings.s3_protocol;
  if (
    protocol === null ||
    protocol.enabled !== true ||
    protocol.region === null ||
    protocol.access_key_id === null ||
    protocol.secret_access_key === null
  )
    return undefined;
  const slot = protocol.secret_access_key.slot;
  const secretAccessKey = secret(state, slot);
  const api = state.ports.find(
    (assignment) => assignment.owner === "stack" && assignment.binding === "api",
  );
  return secretAccessKey === undefined || api === undefined
    ? undefined
    : {
        endpoint: `http://${api.address}:${api.port}/storage/v1/s3`,
        region: protocol.region,
        accessKeyId: protocol.access_key_id,
        secretAccessKey,
      };
};

/** Projects enabled, fully materialized stack credentials without inventing missing values. */
export const projectStackCredentials = (
  state: PersistedStackState,
): Effect.Effect<EffectStackCredentials, StackError> =>
  Effect.sync(() => {
    const database = databaseCredentials(
      state,
      state.registry.instances.find(
        (instance) => instance.id === state.registry.defaultInstanceIds.database,
      ),
    );
    const api = apiCredentials(state);
    const storage = storageCredentials(
      state,
      state.registry.instances.find(
        (instance) => instance.id === state.registry.defaultInstanceIds.storage,
      ),
    );
    return {
      ...(database === undefined
        ? {}
        : {
            database: {
              url: Redacted.make(database.url),
              password: Redacted.make(database.password),
            },
          }),
      ...(api === undefined
        ? {}
        : {
            api: {
              publishableKey: api.publishableKey,
              secretKey: Redacted.make(api.secretKey),
              anonJwt: api.anonJwt,
              serviceRoleJwt: Redacted.make(api.serviceRoleJwt),
            },
          }),
      ...(storage === undefined
        ? {}
        : {
            storage: {
              endpoint: storage.endpoint,
              region: storage.region,
              accessKeyId: storage.accessKeyId,
              secretAccessKey: Redacted.make(storage.secretAccessKey),
            },
          }),
    } satisfies EffectStackCredentials;
  });

/** Projects credentials for one registered instance, including shared API credentials for Functions. */
export function projectServiceCredentials(
  state: PersistedStackState,
  instance: Extract<PersistedServiceInstance, { readonly service: "database" }>,
): Effect.Effect<ServiceCredentials<"database">, StackError>;
export function projectServiceCredentials(
  state: PersistedStackState,
  instance: Extract<PersistedServiceInstance, { readonly service: "functions" }>,
): Effect.Effect<ServiceCredentials<"functions">, StackError>;
export function projectServiceCredentials(
  state: PersistedStackState,
  instance: Extract<PersistedServiceInstance, { readonly service: "storage" }>,
): Effect.Effect<ServiceCredentials<"storage">, StackError>;
export function projectServiceCredentials(
  state: PersistedStackState,
  instance: PersistedServiceInstance,
): Effect.Effect<ServiceCredentials<CapabilityName>, StackError>;
export function projectServiceCredentials(
  state: PersistedStackState,
  instance: PersistedServiceInstance,
): Effect.Effect<ServiceCredentials<CapabilityName>, StackError> {
  switch (instance.service) {
    case "database": {
      const value = databaseCredentials(state, instance);
      return Effect.succeed(value);
    }
    case "functions": {
      const value = apiCredentials(state);
      return Effect.succeed(
        instance.config.enabled && value !== undefined
          ? {
              publishableKey: value.publishableKey,
              secretKey: value.secretKey,
              anonJwt: value.anonJwt,
              serviceRoleJwt: value.serviceRoleJwt,
            }
          : { kind: "none" },
      );
    }
    case "storage": {
      const value = storageCredentials(state, instance);
      return Effect.succeed(
        value === undefined
          ? { kind: "none" }
          : {
              endpoint: value.endpoint,
              region: value.region,
              accessKeyId: value.accessKeyId,
              secretAccessKey: value.secretAccessKey,
            },
      );
    }
    default:
      return Effect.succeed({ kind: "none" });
  }
}
