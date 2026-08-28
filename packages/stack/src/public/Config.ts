import { Schema } from "effect";
import { DatabaseSettingsSchema, type DatabaseSettings } from "../model/capabilities/database.ts";
import { RestSettingsSchema, type RestSettings } from "../model/capabilities/rest.ts";
import { AuthSettingsSchema, type AuthSettings } from "../model/capabilities/auth.ts";
import { RealtimeSettingsSchema, type RealtimeSettings } from "../model/capabilities/realtime.ts";
import { StorageSettingsSchema, type StorageSettings } from "../model/capabilities/storage.ts";
import {
  FunctionsSettingsSchema,
  type FunctionsSettings,
} from "../model/capabilities/functions.ts";
import { StudioSettingsSchema, type StudioSettings } from "../model/capabilities/studio.ts";
import { MailSettingsSchema, type MailSettings } from "../model/capabilities/mail.ts";
import {
  AnalyticsSettingsSchema,
  type AnalyticsSettings,
} from "../model/capabilities/analytics.ts";
import { PoolerSettingsSchema, type PoolerSettings } from "../model/capabilities/pooler.ts";
import { ActivationModeSchema, type ActivationMode } from "./Capability.ts";
import { PORT_FIELDS, type PortField } from "./Status.ts";

export const ListenerPortSchema = Schema.Union([Schema.Literal("automatic"), Schema.Finite]);
export const ListenerConfigSchema = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({
    enabled: Schema.optionalKey(Schema.Literal(true)),
    address: Schema.optionalKey(Schema.String),
    port: Schema.optionalKey(Schema.Finite),
  }),
]);
export type ListenerConfig = Schema.Schema.Type<typeof ListenerConfigSchema>;

const optionalCapability = <S extends Schema.Top>(settings: S) =>
  Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Literal(true)),
      activation: Schema.optionalKey(ActivationModeSchema),
      version: Schema.optionalKey(Schema.String),
      settings: Schema.optionalKey(settings),
    }),
  ]);

export const DatabaseCapabilityConfigSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(DatabaseSettingsSchema),
});
export const StackCapabilitiesConfigSchema = Schema.Struct({
  database: Schema.optionalKey(DatabaseCapabilityConfigSchema),
  rest: Schema.optionalKey(optionalCapability(RestSettingsSchema)),
  auth: Schema.optionalKey(optionalCapability(AuthSettingsSchema)),
  realtime: Schema.optionalKey(optionalCapability(RealtimeSettingsSchema)),
  storage: Schema.optionalKey(optionalCapability(StorageSettingsSchema)),
  functions: Schema.optionalKey(optionalCapability(FunctionsSettingsSchema)),
  studio: Schema.optionalKey(optionalCapability(StudioSettingsSchema)),
  mail: Schema.optionalKey(optionalCapability(MailSettingsSchema)),
  analytics: Schema.optionalKey(optionalCapability(AnalyticsSettingsSchema)),
  pooler: Schema.optionalKey(optionalCapability(PoolerSettingsSchema)),
});

const listenerFields = {
  [PORT_FIELDS[0]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[1]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[2]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[3]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[4]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[5]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[6]]: Schema.optionalKey(ListenerConfigSchema),
  [PORT_FIELDS[7]]: Schema.optionalKey(ListenerConfigSchema),
} satisfies { readonly [Name in PortField]: Schema.Top };
export const StackListenersConfigSchema = Schema.Struct(listenerFields);

export const JwtSigningSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("symmetric"), secret: Schema.Redacted(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("jwks-file"), path: Schema.String }),
]);
export type JwtSigning = Schema.Schema.Type<typeof JwtSigningSchema>;
export const StackSecurityConfigSchema = Schema.Struct({
  jwt: Schema.optionalKey(
    Schema.Struct({
      issuer: Schema.optionalKey(Schema.String),
      signing: Schema.optionalKey(JwtSigningSchema),
    }),
  ),
});

export const StackConfigSchema = Schema.Struct({
  capabilities: Schema.optionalKey(StackCapabilitiesConfigSchema),
  listeners: Schema.optionalKey(StackListenersConfigSchema),
  security: Schema.optionalKey(StackSecurityConfigSchema),
});
export type StackConfig = Schema.Schema.Type<typeof StackConfigSchema>;
export type StackCapabilitiesConfig = Schema.Schema.Type<typeof StackCapabilitiesConfigSchema>;
export type StackSecurityConfig = Schema.Schema.Type<typeof StackSecurityConfigSchema>;
export {
  DatabaseSettingsSchema,
  RestSettingsSchema,
  AuthSettingsSchema,
  RealtimeSettingsSchema,
  StorageSettingsSchema,
  FunctionsSettingsSchema,
  StudioSettingsSchema,
  MailSettingsSchema,
  AnalyticsSettingsSchema,
  PoolerSettingsSchema,
};
export type {
  DatabaseSettings,
  RestSettings,
  AuthSettings,
  RealtimeSettings,
  StorageSettings,
  FunctionsSettings,
  StudioSettings,
  MailSettings,
  AnalyticsSettings,
  PoolerSettings,
  ActivationMode,
};
