import { Effect, Redacted, Schema, SchemaAST, SchemaGetter, SchemaIssue } from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import {
  AuthModule,
  DatabaseModule,
  FunctionsModule,
  MailModule,
  PoolerModule,
  RealtimeModule,
  RestModule,
  StorageModule,
  StudioModule,
  AnalyticsModule,
  AuthSettingsSchema,
  DatabaseSettingsSchema,
  FunctionsSettingsSchema,
  MailSettingsSchema,
  PoolerSettingsSchema,
  RealtimeSettingsSchema,
  RestSettingsSchema,
  StorageSettingsSchema,
  StudioSettingsSchema,
  AnalyticsSettingsSchema,
} from "../model/capabilities/index.ts";
import type { StackDefinition } from "../model/Compiler.ts";
import type { CapabilityModule } from "../model/CapabilityModule.ts";
import type { CapabilityName } from "../public/Capability.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { StackRuntimeSchema } from "../public/Runtime.ts";
import { DesiredStackLifecycleSchema, NetworkPortSchema, PORT_FIELDS } from "../public/Status.ts";

export const STACK_STATE_FORMAT = "supabase-stack-state-v1" as const;

export const PersistedStackIdentitySchema = Schema.Struct({
  stackId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  projectRoot: Schema.String,
  checkoutRoot: Schema.String,
  workspaceId: Schema.String,
  checkoutId: Schema.String,
  branchContext: Schema.String,
  localProjectKey: Schema.String,
  stackName: Schema.String,
});
export type PersistedStackIdentity = Schema.Schema.Type<typeof PersistedStackIdentitySchema>;

export const HostPortAssignmentSchema = Schema.Struct({
  field: Schema.Literals(PORT_FIELDS),
  port: NetworkPortSchema,
  intent: Schema.Literals(["automatic", "exact"] as const),
});
export type HostPortAssignment = Schema.Schema.Type<typeof HostPortAssignmentSchema>;

/** A durable loopback endpoint used by the host gateway to reach one workload. */
export const PrivatePortAssignmentSchema = Schema.Struct({
  workloadId: Schema.String.check(Schema.isNonEmpty()),
  binding: Schema.String.check(Schema.isNonEmpty()),
  port: NetworkPortSchema,
});
export type PrivatePortAssignment = Schema.Schema.Type<typeof PrivatePortAssignmentSchema>;

export const PersistedSecretEntrySchema = Schema.Struct({
  policy: Schema.Literals(["managed", "passthrough"] as const),
  value: Schema.String,
});
export type PersistedSecretEntry = Schema.Schema.Type<typeof PersistedSecretEntrySchema>;

/** Secret slots are dynamic because function environment names are user-defined. */
export const PersistedSecretValuesSchema = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:/-]+$/)),
  PersistedSecretEntrySchema,
);
export type PersistedSecretValues = Schema.Schema.Type<typeof PersistedSecretValuesSchema>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !Redacted.isRedacted(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
};

const isSecretSlot = (value: unknown): value is { readonly slot: string } =>
  hasExactKeys(value, ["slot"]) && typeof value.slot === "string" && value.slot.length > 0;

/** Convert persisted materialized leaves back to the input representation solely for validation. */
const restoreForValidation = (value: unknown): unknown => {
  if (isSecretSlot(value)) return Redacted.make("");
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(restoreForValidation);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, restoreForValidation(entry)] as const)
        .filter(([, entry]) => entry !== undefined),
    );
  }
  return value;
};

const hasCompleteDefaults = (value: unknown, defaults: unknown): boolean => {
  if (Array.isArray(defaults)) return Array.isArray(value);
  if (!isRecord(defaults)) return value !== undefined;
  if (!isRecord(value)) return false;
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(value, key)) return false;
    const defaultValue = defaults[key];
    const actualValue = value[key];
    if (isRecord(defaultValue) && Object.keys(defaultValue).length > 0) {
      if (!hasCompleteDefaults(actualValue, defaultValue)) return false;
    }
  }
  return true;
};

const capabilityKeys = ["enabled", "activation", "version", "settings"] as const;

const invalid = (message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue({ message }));

const validateDynamicRecords = (
  name: CapabilityName,
  settings: unknown,
): Effect.Effect<void, SchemaIssue.Issue> => {
  if (!isRecord(settings)) return Effect.void;
  if (name === "functions" && isRecord(settings.functions)) {
    for (const [slug, value] of Object.entries(settings.functions)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(slug))
        return invalid(`Materialized function ${slug} has an invalid name`);
      if (
        !hasExactKeys(value, [
          "enabled",
          "verify_jwt",
          "import_map",
          "entrypoint",
          "static_files",
          "env",
        ])
      )
        return invalid(`Materialized function ${slug} is missing a defaulted field`);
      if (!isRecord(value.env)) return invalid(`Materialized function ${slug} has invalid env`);
      for (const secret of Object.values(value.env))
        if (!isSecretSlot(secret)) return invalid("Function secret must be a slot");
    }
  }
  if (name === "storage" && isRecord(settings.buckets)) {
    for (const [bucket, value] of Object.entries(settings.buckets)) {
      if (!hasExactKeys(value, ["public", "file_size_limit", "allowed_mime_types", "objects_path"]))
        return invalid(`Materialized bucket ${bucket} is missing a defaulted field`);
    }
  }
  if (name === "auth" && isRecord(settings.email)) {
    const template = settings.email.template;
    if (isRecord(template)) {
      for (const [name, value] of Object.entries(template))
        if (!hasExactKeys(value, ["subject", "content_path"]))
          return invalid(`Materialized auth email template ${name} is missing a defaulted field`);
    }
    const notification = settings.email.notification;
    if (isRecord(notification)) {
      for (const [name, value] of Object.entries(notification))
        if (!hasExactKeys(value, ["enabled", "subject", "content_path"]))
          return invalid(
            `Materialized auth email notification ${name} is missing a defaulted field`,
          );
    }
  }
  return Effect.void;
};

const validateModuleSettings = <T>(
  module: CapabilityModule<T>,
  schema: Schema.Codec<T, unknown, never, never>,
  settings: unknown,
  options: SchemaAST.ParseOptions,
): Effect.Effect<void, SchemaIssue.Issue> => {
  if (!hasCompleteDefaults(settings, module.defaultSettings))
    return invalid(`Materialized ${module.name} settings are incomplete`);
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
    restoreForValidation(settings),
    options,
  ).pipe(
    Effect.asVoid,
    Effect.mapError((error) => error.issue),
    Effect.flatMap(() => validateDynamicRecords(module.name, settings)),
  );
};

const validateModuleSettingsByName = (
  name: CapabilityName,
  settings: unknown,
  options: SchemaAST.ParseOptions,
) => {
  switch (name) {
    case "database":
      return validateModuleSettings(DatabaseModule, DatabaseSettingsSchema, settings, options);
    case "rest":
      return validateModuleSettings(RestModule, RestSettingsSchema, settings, options);
    case "auth":
      return validateModuleSettings(AuthModule, AuthSettingsSchema, settings, options);
    case "realtime":
      return validateModuleSettings(RealtimeModule, RealtimeSettingsSchema, settings, options);
    case "storage":
      return validateModuleSettings(StorageModule, StorageSettingsSchema, settings, options);
    case "functions":
      return validateModuleSettings(FunctionsModule, FunctionsSettingsSchema, settings, options);
    case "studio":
      return validateModuleSettings(StudioModule, StudioSettingsSchema, settings, options);
    case "mail":
      return validateModuleSettings(MailModule, MailSettingsSchema, settings, options);
    case "analytics":
      return validateModuleSettings(AnalyticsModule, AnalyticsSettingsSchema, settings, options);
    case "pooler":
      return validateModuleSettings(PoolerModule, PoolerSettingsSchema, settings, options);
  }
};

const isDefinitionShape = (input: unknown): input is StackDefinition => {
  if (!hasExactKeys(input, ["capabilities", "listeners", "security"])) return false;
  const capabilities = input.capabilities;
  if (!hasExactKeys(capabilities, CAPABILITY_NAMES)) return false;
  for (const name of CAPABILITY_NAMES) {
    const capability = capabilities[name];
    if (!hasExactKeys(capability, capabilityKeys)) return false;
    if (typeof capability.enabled !== "boolean") return false;
    if (capability.activation !== "eager" && capability.activation !== "lazy") return false;
    if (typeof capability.version !== "string" || capability.version.length === 0) return false;
  }
  const listeners = input.listeners;
  if (!hasExactKeys(listeners, PORT_FIELDS)) return false;
  for (const field of PORT_FIELDS) {
    const listener = listeners[field];
    if (!hasExactKeys(listener, ["enabled", "address", "port"])) return false;
    if (typeof listener.enabled !== "boolean" || typeof listener.address !== "string") return false;
    if (!(listener.port === "automatic" || Schema.is(NetworkPortSchema)(listener.port)))
      return false;
  }
  const security = input.security;
  if (!hasExactKeys(security, ["jwt"]) || !hasExactKeys(security.jwt, ["issuer", "signing"]))
    return false;
  const jwt = security.jwt;
  if (!(jwt.issuer === null || typeof jwt.issuer === "string")) return false;
  const signing = jwt.signing;
  if (signing === null) return true;
  if (!isRecord(signing)) return false;
  if (signing.kind === "symmetric")
    return hasExactKeys(signing, ["kind", "secret"]) && isSecretSlot(signing.secret);
  return (
    hasExactKeys(signing, ["kind", "path"]) &&
    signing.kind === "jwks-file" &&
    typeof signing.path === "string"
  );
};

/** One closed, exhaustive schema for the compiler's fully materialized definition. */
export const StackDefinitionSchema = Schema.declareConstructor<StackDefinition>()(
  [],
  () => (input, ast, options) =>
    Effect.gen(function* () {
      if (!isDefinitionShape(input))
        return yield* invalid("Materialized definition shape is invalid");
      const capabilities = input.capabilities;
      for (const name of CAPABILITY_NAMES) {
        const capability = capabilities[name];
        yield* validateModuleSettingsByName(name, capability.settings, options);
      }
      return input;
    }),
  { title: "Materialized StackDefinition" },
);

const PortAssignmentsSchema = Schema.Array(HostPortAssignmentSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((assignments) =>
      Effect.succeed(
        new Set(assignments.map(({ field }) => field)).size === assignments.length &&
          new Set(assignments.map(({ port }) => port)).size === assignments.length
          ? undefined
          : "Duplicate persisted port field or port",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const PrivatePortAssignmentsSchema = Schema.Array(PrivatePortAssignmentSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((assignments) =>
      Effect.succeed(
        new Set(assignments.map(({ workloadId, binding }) => `${workloadId}\u0000${binding}`))
          .size === assignments.length &&
          new Set(assignments.map(({ port }) => port)).size === assignments.length
          ? undefined
          : "Duplicate persisted private binding or port",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const StackGenerationSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const stateShape = Schema.Struct({
  format: Schema.Literal(STACK_STATE_FORMAT),
  identity: PersistedStackIdentitySchema,
  runtime: StackRuntimeSchema,
  desiredGeneration: StackGenerationSchema,
  desiredLifecycle: DesiredStackLifecycleSchema,
  definition: Schema.optional(StackDefinitionSchema),
  inputFingerprint: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  ports: PortAssignmentsSchema,
  privatePorts: PrivatePortAssignmentsSchema,
  secrets: PersistedSecretValuesSchema,
});

/** Complete durable state. Definition and fingerprint are intentionally an all-or-none pair. */
export const PersistedStackStateSchema = stateShape.pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((state) =>
      Effect.succeed(
        (state.definition === undefined) !== (state.inputFingerprint === undefined)
          ? "definition and inputFingerprint must be persisted together"
          : state.ports.some(({ port }) => state.privatePorts.some((entry) => entry.port === port))
            ? "Public and private persisted ports must not overlap"
            : undefined,
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);
export type PersistedStackState = Schema.Schema.Type<typeof PersistedStackStateSchema>;

export const isPersistedStackIdentity = (value: unknown): value is PersistedStackIdentity =>
  Schema.is(PersistedStackIdentitySchema)(value);

export const toPersistedIdentity = (
  identity: StackIdentity,
  stackId: string,
): PersistedStackIdentity => ({
  stackId,
  projectRoot: identity.projectRoot,
  checkoutRoot: identity.checkoutRoot,
  workspaceId: identity.workspaceId,
  checkoutId: identity.checkoutId,
  branchContext: identity.branchContext,
  localProjectKey: identity.localProjectKey,
  stackName: identity.stackName,
});
