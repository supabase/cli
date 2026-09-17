import { Effect, Redacted, Schema, SchemaAST, SchemaIssue } from "effect";
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
import type {
  AnalyticsSettings,
  AuthSettings,
  DatabaseSettings,
  FunctionsSettings,
  MailSettings,
  PoolerSettings,
  RealtimeSettings,
  RestSettings,
  StorageSettings,
  StudioSettings,
} from "../model/capabilities/index.ts";
import type { MaterializedSettings } from "../model/CapabilityModule.ts";
import type { CapabilityName } from "../public/Capability.ts";

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
      if (!isRecord(value)) return invalid(`Materialized function ${slug} is not an object`);
      const allowedKeys = new Set([
        "enabled",
        "verify_jwt",
        "import_map",
        "entrypoint",
        "static_files",
        "env",
      ]);
      if (
        !Object.hasOwn(value, "enabled") ||
        !Object.hasOwn(value, "env") ||
        Object.keys(value).some((key) => !allowedKeys.has(key))
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
  module: { readonly name: CapabilityName; readonly defaultSettings: unknown },
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

type MaterializedSettingsByName = {
  database: MaterializedSettings<DatabaseSettings>;
  rest: MaterializedSettings<RestSettings>;
  auth: MaterializedSettings<AuthSettings>;
  realtime: MaterializedSettings<RealtimeSettings>;
  storage: MaterializedSettings<StorageSettings>;
  functions: MaterializedSettings<FunctionsSettings>;
  studio: MaterializedSettings<StudioSettings>;
  mail: MaterializedSettings<MailSettings>;
  analytics: MaterializedSettings<AnalyticsSettings>;
  pooler: MaterializedSettings<PoolerSettings>;
};

/** Validates a materialized leaf and preserves its service-specific type for registry codecs. */
export const validateMaterializedSettingsByName = <K extends CapabilityName>(
  name: K,
  settings: unknown,
  options: SchemaAST.ParseOptions,
): Effect.Effect<MaterializedSettingsByName[K], SchemaIssue.Issue> =>
  validateModuleSettingsByName(name, settings, options).pipe(
    Effect.as(settings as MaterializedSettingsByName[K]),
  );
