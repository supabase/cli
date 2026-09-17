import { Schema } from "effect";
import type { Effect } from "effect";
import type { Stream } from "effect";
import * as Redacted from "effect/Redacted";
import {
  AnalyticsSettingsSchema,
  type AnalyticsSettings,
  AuthSettingsSchema,
  type AuthSettings,
  DatabaseSettingsSchema,
  type DatabaseSettings,
  FunctionsSettingsSchema,
  type FunctionsSettings,
  MailSettingsSchema,
  type MailSettings,
  PoolerSettingsSchema,
  type PoolerSettings,
  RealtimeSettingsSchema,
  type RealtimeSettings,
  RestSettingsSchema,
  type RestSettings,
  StorageSettingsSchema,
  type StorageSettings,
  StudioSettingsSchema,
  type StudioSettings,
} from "../model/capabilities/index.ts";
import { CAPABILITY_NAMES, CapabilityNameSchema, type CapabilityName } from "./Capability.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "./ServiceInstanceId.ts";
import { NetworkPortSchema } from "./Status.ts";
import type {
  ApiCredentials,
  DatabaseCredentials,
  EmptyServiceCredentials,
  StorageCredentials,
} from "./Credentials.ts";

export type ServiceKind = CapabilityName;
export const SERVICE_KINDS = CAPABILITY_NAMES;
export const ServiceKindSchema = CapabilityNameSchema;

export const TcpEndpointIntentSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Literal(true)),
  address: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Union([Schema.Literal("auto"), NetworkPortSchema])),
});
export type TcpEndpointIntent = Schema.Schema.Type<typeof TcpEndpointIntentSchema>;

export const DisabledEndpointIntentSchema = Schema.Struct({ enabled: Schema.Literal(false) });
export const OptionalEndpointIntentSchema = Schema.Union([
  DisabledEndpointIntentSchema,
  TcpEndpointIntentSchema,
]);
export type OptionalEndpointIntent = Schema.Schema.Type<typeof OptionalEndpointIntentSchema>;

type Unredact<T> =
  T extends Redacted.Redacted<infer Value>
    ? Value
    : T extends readonly (infer Item)[]
      ? readonly Unredact<Item>[]
      : T extends object
        ? { [Key in keyof T]: Unredact<T[Key]> }
        : T;

type Redact<T> =
  T extends Redacted.Redacted<unknown>
    ? { readonly redacted: true }
    : T extends null
      ? undefined
      : T extends readonly (infer Item)[]
        ? readonly Redact<Item>[]
        : T extends object
          ? { [Key in keyof T]: Redact<T[Key]> }
          : T;

type ServiceSettingsMap = {
  database: DatabaseSettings;
  rest: RestSettings;
  auth: AuthSettings;
  realtime: RealtimeSettings;
  storage: StorageSettings;
  functions: FunctionsSettings;
  studio: StudioSettings;
  mail: MailSettings;
  analytics: AnalyticsSettings;
  pooler: PoolerSettings;
};
export type ServiceSettings<K extends ServiceKind> = ServiceSettingsMap[K];
export type RedactedServiceSettings<K extends ServiceKind> = Redact<ServiceSettings<K>>;

export type PromiseDatabaseSettings = Unredact<DatabaseSettings>;
export type PromiseRestSettings = Unredact<RestSettings>;
export type PromiseAuthSettings = Unredact<AuthSettings>;
export type PromiseRealtimeSettings = Unredact<RealtimeSettings>;
export type PromiseStorageSettings = Unredact<StorageSettings>;
export type PromiseFunctionsSettings = Unredact<FunctionsSettings>;
export type PromiseStudioSettings = Unredact<StudioSettings>;
export type PromiseMailSettings = Unredact<MailSettings>;
export type PromiseAnalyticsSettings = Unredact<AnalyticsSettings>;
export type PromisePoolerSettings = Unredact<PoolerSettings>;

export interface DatabaseServiceConfig {
  readonly enabled?: boolean;
  readonly version?: string;
  readonly activation?: "eager" | "lazy";
  readonly idleTimeoutSeconds?: false;
  readonly settings?: PromiseDatabaseSettings;
  readonly password?: string;
  readonly endpoints?: { readonly sql?: OptionalEndpointIntent };
}

export interface FunctionsServiceConfig {
  readonly enabled?: boolean;
  readonly version?: string;
  readonly activation?: "eager" | "lazy";
  readonly idleTimeoutSeconds?: false;
  readonly settings?: PromiseFunctionsSettings;
  readonly endpoints?: { readonly inspector?: OptionalEndpointIntent };
}

interface ServiceConfigBase<Settings> {
  readonly enabled?: boolean;
  readonly version?: string;
  readonly activation?: "eager" | "lazy";
  readonly idleTimeoutSeconds?: false;
  readonly settings?: Settings;
}

interface RetirableServiceConfig<Settings> extends Omit<
  ServiceConfigBase<Settings>,
  "idleTimeoutSeconds"
> {
  readonly idleTimeoutSeconds?: number | false;
}

export type ServiceConfigMap = {
  database: DatabaseServiceConfig;
  rest: RetirableServiceConfig<PromiseRestSettings>;
  auth: RetirableServiceConfig<PromiseAuthSettings>;
  realtime: RetirableServiceConfig<PromiseRealtimeSettings>;
  storage: ServiceConfigBase<PromiseStorageSettings>;
  functions: FunctionsServiceConfig;
  studio: RetirableServiceConfig<PromiseStudioSettings> & {
    readonly endpoints?: { readonly studio?: OptionalEndpointIntent };
  };
  mail: ServiceConfigBase<PromiseMailSettings> & {
    readonly endpoints?: {
      readonly smtp?: OptionalEndpointIntent;
      readonly pop3?: OptionalEndpointIntent;
      readonly mailUi?: OptionalEndpointIntent;
    };
  };
  analytics: ServiceConfigBase<PromiseAnalyticsSettings>;
  pooler: RetirableServiceConfig<PromisePoolerSettings> & {
    readonly endpoints?: { readonly pooler?: OptionalEndpointIntent };
  };
};
export type ServiceConfig<K extends ServiceKind> = ServiceConfigMap[K];
export type AnyServiceConfig = {
  [K in ServiceKind]: ServiceConfig<K>;
}[ServiceKind];

/** Effect-native configuration keeps secret leaves wrapped in Redacted values. */
export type EffectServiceConfigMap = {
  database: Omit<DatabaseServiceConfig, "settings" | "password"> & {
    readonly settings?: DatabaseSettings;
    readonly password?: Redacted.Redacted<string>;
  };
  rest: RetirableServiceConfig<RestSettings>;
  auth: RetirableServiceConfig<AuthSettings>;
  realtime: RetirableServiceConfig<RealtimeSettings>;
  storage: ServiceConfigBase<StorageSettings>;
  functions: Omit<FunctionsServiceConfig, "settings"> & { readonly settings?: FunctionsSettings };
  studio: RetirableServiceConfig<StudioSettings> & {
    readonly endpoints?: { readonly studio?: OptionalEndpointIntent };
  };
  mail: ServiceConfigBase<MailSettings> & {
    readonly endpoints?: {
      readonly smtp?: OptionalEndpointIntent;
      readonly pop3?: OptionalEndpointIntent;
      readonly mailUi?: OptionalEndpointIntent;
    };
  };
  analytics: ServiceConfigBase<AnalyticsSettings>;
  pooler: RetirableServiceConfig<PoolerSettings> & {
    readonly endpoints?: { readonly pooler?: OptionalEndpointIntent };
  };
};
export type EffectServiceConfig<K extends ServiceKind> = EffectServiceConfigMap[K];
export type AnyEffectServiceConfig = {
  [K in ServiceKind]: EffectServiceConfig<K>;
}[ServiceKind];

const serviceConfigFields = <S extends Schema.Top>(settings: S) => ({
  enabled: Schema.optional(Schema.Literal(true)),
  version: Schema.optional(Schema.String),
  activation: Schema.optional(Schema.Literals(["eager", "lazy"] as const)),
  settings: Schema.optional(settings),
});
const retirableConfig = <S extends Schema.Top>(settings: S) =>
  Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(settings),
      idleTimeoutSeconds: Schema.optionalKey(
        Schema.Union([Schema.Literal(false), Schema.Finite.check(Schema.isGreaterThan(0))]),
      ),
    }),
  ]);
const fixedConfig = <S extends Schema.Top>(settings: S) =>
  Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(settings),
    }),
  ]);

/** Effect input codecs for each service kind; secret leaves remain Redacted values. */
export const ServiceConfigSchemas = {
  database: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(DatabaseSettingsSchema),
      idleTimeoutSeconds: Schema.optionalKey(Schema.Literal(false)),
      password: Schema.optionalKey(Schema.Redacted(Schema.String)),
      endpoints: Schema.optionalKey(
        Schema.Struct({ sql: Schema.optionalKey(OptionalEndpointIntentSchema) }),
      ),
    }),
  ]),
  rest: retirableConfig(RestSettingsSchema),
  auth: retirableConfig(AuthSettingsSchema),
  realtime: retirableConfig(RealtimeSettingsSchema),
  storage: fixedConfig(StorageSettingsSchema),
  functions: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(FunctionsSettingsSchema),
      endpoints: Schema.optionalKey(
        Schema.Struct({ inspector: Schema.optionalKey(OptionalEndpointIntentSchema) }),
      ),
    }),
  ]),
  studio: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(StudioSettingsSchema),
      idleTimeoutSeconds: Schema.optionalKey(
        Schema.Union([Schema.Literal(false), Schema.Finite.check(Schema.isGreaterThan(0))]),
      ),
      endpoints: Schema.optionalKey(
        Schema.Struct({ studio: Schema.optionalKey(OptionalEndpointIntentSchema) }),
      ),
    }),
  ]),
  mail: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(MailSettingsSchema),
      endpoints: Schema.optionalKey(
        Schema.Struct({
          smtp: Schema.optionalKey(OptionalEndpointIntentSchema),
          pop3: Schema.optionalKey(OptionalEndpointIntentSchema),
          mailUi: Schema.optionalKey(OptionalEndpointIntentSchema),
        }),
      ),
    }),
  ]),
  analytics: fixedConfig(AnalyticsSettingsSchema),
  pooler: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({
      ...serviceConfigFields(PoolerSettingsSchema),
      idleTimeoutSeconds: Schema.optionalKey(
        Schema.Union([Schema.Literal(false), Schema.Finite.check(Schema.isGreaterThan(0))]),
      ),
      endpoints: Schema.optionalKey(
        Schema.Struct({ pooler: Schema.optionalKey(OptionalEndpointIntentSchema) }),
      ),
    }),
  ]),
} satisfies { readonly [K in ServiceKind]: Schema.Top };

const catalogRecipeSchema = <S extends Schema.Top>(settings: S) =>
  Schema.Struct({
    version: Schema.optionalKey(Schema.String),
    settings: Schema.optionalKey(settings),
  });

const catalogInitializationSchema = Schema.Struct({
  from: Schema.optionalKey(Schema.Never),
  catalog: Schema.optionalKey(
    Schema.Struct({
      auth: Schema.optionalKey(catalogRecipeSchema(AuthSettingsSchema)),
      storage: Schema.optionalKey(catalogRecipeSchema(StorageSettingsSchema)),
      realtime: Schema.optionalKey(catalogRecipeSchema(RealtimeSettingsSchema)),
      analytics: Schema.optionalKey(catalogRecipeSchema(AnalyticsSettingsSchema)),
      pooler: Schema.optionalKey(catalogRecipeSchema(PoolerSettingsSchema)),
    }),
  ),
});

export const EffectDatabaseInitializationSchema = Schema.Union(
  [
    catalogInitializationSchema,
    Schema.Struct({
      catalog: Schema.optionalKey(Schema.Never),
      from: ServiceInstanceIdSchema,
    }),
  ],
  { mode: "oneOf" },
);

const serviceDependenciesSchemas = {
  database: Schema.Struct({}),
  rest: Schema.Struct({ database: ServiceInstanceIdSchema }),
  auth: Schema.Struct({ database: ServiceInstanceIdSchema }),
  realtime: Schema.Struct({ database: ServiceInstanceIdSchema }),
  storage: Schema.Struct({ database: ServiceInstanceIdSchema }),
  functions: Schema.Struct({}),
  studio: Schema.Struct({
    database: ServiceInstanceIdSchema,
    rest: ServiceInstanceIdSchema,
    analytics: ServiceInstanceIdSchema,
  }),
  mail: Schema.Struct({}),
  analytics: Schema.Struct({ database: ServiceInstanceIdSchema }),
  pooler: Schema.Struct({ database: ServiceInstanceIdSchema }),
};

const serviceInitializationSchemas = {
  database: EffectDatabaseInitializationSchema,
  rest: Schema.Struct({}),
  auth: Schema.Struct({}),
  realtime: Schema.Struct({}),
  storage: Schema.Struct({}),
  functions: Schema.Struct({}),
  studio: Schema.Struct({}),
  mail: Schema.Struct({}),
  analytics: Schema.Struct({}),
  pooler: Schema.Struct({}),
};

const createServiceSchemas = {
  database: Schema.Struct({
    service: Schema.Literal("database"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.database,
    initialization: Schema.optional(serviceInitializationSchemas.database),
  }),
  rest: Schema.Struct({
    service: Schema.Literal("rest"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.rest,
    dependencies: serviceDependenciesSchemas.rest,
  }),
  auth: Schema.Struct({
    service: Schema.Literal("auth"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.auth,
    dependencies: serviceDependenciesSchemas.auth,
  }),
  realtime: Schema.Struct({
    service: Schema.Literal("realtime"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.realtime,
    dependencies: serviceDependenciesSchemas.realtime,
  }),
  storage: Schema.Struct({
    service: Schema.Literal("storage"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.storage,
    dependencies: serviceDependenciesSchemas.storage,
  }),
  functions: Schema.Struct({
    service: Schema.Literal("functions"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.functions,
  }),
  studio: Schema.Struct({
    service: Schema.Literal("studio"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.studio,
    dependencies: serviceDependenciesSchemas.studio,
  }),
  mail: Schema.Struct({
    service: Schema.Literal("mail"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.mail,
  }),
  analytics: Schema.Struct({
    service: Schema.Literal("analytics"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.analytics,
    dependencies: serviceDependenciesSchemas.analytics,
  }),
  pooler: Schema.Struct({
    service: Schema.Literal("pooler"),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    config: ServiceConfigSchemas.pooler,
    dependencies: serviceDependenciesSchemas.pooler,
  }),
};

const effectCreateServiceOptionsUnion = Schema.Union([
  createServiceSchemas.database,
  createServiceSchemas.rest,
  createServiceSchemas.auth,
  createServiceSchemas.realtime,
  createServiceSchemas.storage,
  createServiceSchemas.functions,
  createServiceSchemas.studio,
  createServiceSchemas.mail,
  createServiceSchemas.analytics,
  createServiceSchemas.pooler,
]);

/** Runtime codec for Effect-native service creation options across all service kinds. */
export const EffectCreateServiceOptionsSchema = effectCreateServiceOptionsUnion;

const serviceRestartSchemas = {
  database: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("database"),
    config: Schema.optionalKey(ServiceConfigSchemas.database),
  }),
  rest: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("rest"),
    config: Schema.optionalKey(ServiceConfigSchemas.rest),
  }),
  auth: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("auth"),
    config: Schema.optionalKey(ServiceConfigSchemas.auth),
  }),
  realtime: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("realtime"),
    config: Schema.optionalKey(ServiceConfigSchemas.realtime),
  }),
  storage: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("storage"),
    config: Schema.optionalKey(ServiceConfigSchemas.storage),
  }),
  functions: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("functions"),
    config: Schema.optionalKey(ServiceConfigSchemas.functions),
  }),
  studio: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("studio"),
    config: Schema.optionalKey(ServiceConfigSchemas.studio),
  }),
  mail: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("mail"),
    config: Schema.optionalKey(ServiceConfigSchemas.mail),
  }),
  analytics: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("analytics"),
    config: Schema.optionalKey(ServiceConfigSchemas.analytics),
  }),
  pooler: Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal("pooler"),
    config: Schema.optionalKey(ServiceConfigSchemas.pooler),
  }),
};

export type ServiceRestartPayload = {
  [K in ServiceKind]: {
    readonly id: ServiceInstanceId;
    readonly service: K;
    readonly config?: EffectServiceConfig<K>;
  };
}[ServiceKind];

/** Runtime codec for a service-kind-specific restart request. */
export const ServiceRestartPayloadSchema = Schema.Union([
  serviceRestartSchemas.database,
  serviceRestartSchemas.rest,
  serviceRestartSchemas.auth,
  serviceRestartSchemas.realtime,
  serviceRestartSchemas.storage,
  serviceRestartSchemas.functions,
  serviceRestartSchemas.studio,
  serviceRestartSchemas.mail,
  serviceRestartSchemas.analytics,
  serviceRestartSchemas.pooler,
]);

export interface CatalogRecipeInput<Settings> {
  readonly version?: string;
  readonly settings?: Settings;
}

export type DatabaseInitialization =
  | {
      readonly from: ServiceInstanceId;
    }
  | {
      readonly catalog?: {
        readonly auth?: CatalogRecipeInput<PromiseAuthSettings>;
        readonly storage?: CatalogRecipeInput<PromiseStorageSettings>;
        readonly realtime?: CatalogRecipeInput<PromiseRealtimeSettings>;
        readonly analytics?: CatalogRecipeInput<PromiseAnalyticsSettings>;
        readonly pooler?: CatalogRecipeInput<PromisePoolerSettings>;
      };
    };

export type EffectDatabaseInitialization =
  | {
      readonly from: ServiceInstanceId;
    }
  | {
      readonly catalog?: {
        readonly auth?: CatalogRecipeInput<AuthSettings>;
        readonly storage?: CatalogRecipeInput<StorageSettings>;
        readonly realtime?: CatalogRecipeInput<RealtimeSettings>;
        readonly analytics?: CatalogRecipeInput<AnalyticsSettings>;
        readonly pooler?: CatalogRecipeInput<PoolerSettings>;
      };
    };

export type ServiceInitialization<K extends ServiceKind> = K extends "database"
  ? DatabaseInitialization
  : never;
export type EffectServiceInitialization<K extends ServiceKind> = K extends "database"
  ? EffectDatabaseInitialization
  : never;

type DependencyMap = {
  database: never;
  rest: { readonly database: ServiceInstanceId };
  auth: { readonly database: ServiceInstanceId };
  realtime: { readonly database: ServiceInstanceId };
  storage: { readonly database: ServiceInstanceId };
  functions: never;
  studio: {
    readonly database: ServiceInstanceId;
    readonly rest: ServiceInstanceId;
    readonly analytics: ServiceInstanceId;
  };
  mail: never;
  analytics: { readonly database: ServiceInstanceId };
  pooler: { readonly database: ServiceInstanceId };
};
export type ServiceDependencies<K extends ServiceKind> = DependencyMap[K];

export type CreateServiceOptions<K extends ServiceKind> = {
  readonly service: K;
  readonly name?: string;
  readonly config: ServiceConfig<K>;
  readonly initialization?: ServiceInitialization<K>;
} & (ServiceDependencies<K> extends never
  ? { readonly dependencies?: never }
  : { readonly dependencies: ServiceDependencies<K> });
export type AnyCreateServiceOptions = {
  [K in ServiceKind]: CreateServiceOptions<K>;
}[ServiceKind];

export type EffectCreateServiceOptions<K extends ServiceKind> = Omit<
  CreateServiceOptions<K>,
  "service" | "config" | "initialization"
> & {
  readonly service: K;
  readonly config: EffectServiceConfig<K>;
  readonly initialization?: EffectServiceInitialization<K>;
};
export type AnyEffectCreateServiceOptions = {
  [K in ServiceKind]: EffectCreateServiceOptions<K>;
}[ServiceKind];

export type ServiceRef = { readonly id: ServiceInstanceId } | { readonly name: string };

export interface ServiceDescriptor<K extends ServiceKind = ServiceKind> {
  readonly id: ServiceInstanceId;
  readonly service: K;
  readonly name?: string;
  readonly enabled: boolean;
  readonly config: {
    readonly enabled: boolean;
    readonly activation: "eager" | "lazy";
    readonly idleTimeoutSeconds: number | false;
    readonly version: string;
    readonly settings: RedactedServiceSettings<K>;
  };
  readonly dependencies: Readonly<Record<string, ServiceInstanceId>>;
  readonly snapshotSupport: "supported" | "unsupported";
  readonly endpoints: Readonly<
    Record<string, Omit<TcpEndpointIntent, "port"> & { readonly port: number }>
  >;
  readonly artifactIdentity?: string;
  readonly runtimeIdentity?: string;
  readonly effectiveConfigFingerprint?: string;
  readonly initializationProfileId?: string | null;
  readonly bootstrapRecipeId?: string;
  readonly bootstrapInputsId?: string;
  readonly creationInputsId?: string;
  readonly initialization?: {
    readonly profileId: string;
    readonly recipes: ReadonlyArray<{
      readonly service: ServiceKind;
      readonly recipeId: string;
      readonly artifactIdentity: string;
      readonly completed: boolean;
    }>;
  };
  readonly data:
    | { readonly origin: "absent" }
    | { readonly origin: "fresh"; readonly lineageId: string }
    | { readonly origin: "restored"; readonly snapshot: SnapshotDescriptor }
    | { readonly origin: "incomplete"; readonly operationId: string };
}

export type AnyServiceDescriptor = {
  [K in ServiceKind]: ServiceDescriptor<K>;
}[ServiceKind];

export const SnapshotDescriptorSchema = Schema.Struct({
  lineageId: Schema.String,
  initializationProfileId: Schema.NullOr(Schema.String),
  artifactIdentity: Schema.String,
  runtimeIdentity: Schema.String,
  dataFormat: Schema.Struct({
    provider: Schema.Literal("postgres"),
    format: Schema.String,
    majorVersion: Schema.Int,
  }),
  provenance: Schema.Struct({
    sourceInstanceId: ServiceInstanceIdSchema,
    exportOperationId: Schema.String,
  }),
});
export type SnapshotDescriptor = Schema.Schema.Type<typeof SnapshotDescriptorSchema>;

export type ServiceCredentials<K extends ServiceKind> = K extends "database"
  ? DatabaseCredentials | undefined
  : K extends "functions"
    ? ApiCredentials | EmptyServiceCredentials
    : K extends "storage"
      ? StorageCredentials | EmptyServiceCredentials
      : EmptyServiceCredentials;

export interface PrepareResult {
  readonly instances: ReadonlyArray<{
    readonly id: ServiceInstanceId;
    readonly service: ServiceKind;
    readonly artifacts: ReadonlyArray<{
      readonly identity: string;
      readonly outcome: "cached" | "downloaded" | "pulled";
    }>;
    /** Stable semantic config identity used to compare prepared candidate views. */
    readonly effectiveConfigFingerprint?: string;
  }>;
}

export interface ServiceInstance<K extends ServiceKind> {
  readonly id: ServiceInstanceId;
  readonly service: K;
  readonly name: string | undefined;
  readonly describe: () => Promise<ServiceDescriptor<K>>;
  readonly status: () => Promise<import("./Status.ts").ServiceStatus>;
  readonly credentials: () => Promise<ServiceCredentials<K>>;
  readonly prepare: () => Promise<PrepareResult>;
  readonly start: () => Promise<import("./Status.ts").ServiceStatus>;
  readonly sleep: () => Promise<import("./Status.ts").ServiceStatus>;
  readonly stop: () => Promise<import("./Status.ts").ServiceStatus>;
  readonly restart: (options?: {
    readonly config?: ServiceConfig<K>;
  }) => Promise<import("./Status.ts").ServiceStatus>;
  readonly destroy: () => Promise<void>;
  readonly exportSnapshot: (options: {
    readonly destination: string;
  }) => Promise<SnapshotDescriptor>;
  readonly restoreSnapshot: (options: { readonly source: string }) => Promise<SnapshotDescriptor>;
  readonly logs: (
    query?: import("./Logs.ts").ServiceLogQuery,
  ) => Promise<import("./Logs.ts").StackLogBatch>;
  readonly followLogs: (
    query?: import("./Logs.ts").ServiceLogQuery,
  ) => AsyncIterable<import("./Logs.ts").StackLogEntry>;
  readonly followStatus: () => AsyncIterable<import("./Status.ts").ServiceStatus>;
}

export type AnyServiceInstance = {
  [K in ServiceKind]: ServiceInstance<K>;
}[ServiceKind];

export type { ApiCredentials, DatabaseCredentials, EmptyServiceCredentials, StorageCredentials };

export interface ServiceCollection {
  readonly create: <K extends ServiceKind>(
    options: CreateServiceOptions<K>,
  ) => Promise<ServiceInstance<K>>;
  readonly get: (ref: ServiceRef) => Promise<AnyServiceInstance>;
  readonly list: () => Promise<ReadonlyArray<AnyServiceDescriptor>>;
}

/** Effect-native service handle used by `EffectStack.services`. */
export interface EffectServiceInstance<K extends ServiceKind> {
  readonly id: ServiceInstanceId;
  readonly service: K;
  readonly name: string | undefined;
  readonly describe: Effect.Effect<ServiceDescriptor<K>, import("./Errors.ts").StackError>;
  readonly status: Effect.Effect<
    import("./Status.ts").ServiceStatus,
    import("./Errors.ts").StackError
  >;
  readonly credentials: Effect.Effect<ServiceCredentials<K>, import("./Errors.ts").StackError>;
  readonly prepare: Effect.Effect<PrepareResult, import("./Errors.ts").StackError>;
  readonly start: Effect.Effect<
    import("./Status.ts").ServiceStatus,
    import("./Errors.ts").StackError
  >;
  readonly sleep: Effect.Effect<
    import("./Status.ts").ServiceStatus,
    import("./Errors.ts").StackError
  >;
  readonly stop: Effect.Effect<
    import("./Status.ts").ServiceStatus,
    import("./Errors.ts").StackError
  >;
  readonly restart: (options?: {
    readonly config?: EffectServiceConfig<K>;
  }) => Effect.Effect<import("./Status.ts").ServiceStatus, import("./Errors.ts").StackError>;
  readonly destroy: Effect.Effect<void, import("./Errors.ts").StackError>;
  readonly exportSnapshot: (options: {
    readonly destination: string;
  }) => Effect.Effect<SnapshotDescriptor, import("./Errors.ts").StackError>;
  readonly restoreSnapshot: (options: {
    readonly source: string;
  }) => Effect.Effect<SnapshotDescriptor, import("./Errors.ts").StackError>;
  readonly logs: (
    query?: import("./Logs.ts").ServiceLogQuery,
  ) => Effect.Effect<import("./Logs.ts").StackLogBatch, import("./Errors.ts").StackError>;
  readonly followLogs: (
    query?: import("./Logs.ts").ServiceLogQuery,
  ) => Stream.Stream<import("./Logs.ts").StackLogEntry, import("./Errors.ts").StackError>;
  readonly followStatus: Stream.Stream<
    import("./Status.ts").ServiceStatus,
    import("./Errors.ts").StackError
  >;
}

export type AnyEffectServiceInstance = {
  [K in ServiceKind]: EffectServiceInstance<K>;
}[ServiceKind];

/** Effect-native service registry facade. */
export interface EffectServiceCollection {
  readonly create: <K extends ServiceKind>(
    options: EffectCreateServiceOptions<K>,
  ) => Effect.Effect<EffectServiceInstance<K>, import("./Errors.ts").StackError>;
  readonly get: (
    ref: ServiceRef,
  ) => Effect.Effect<AnyEffectServiceInstance, import("./Errors.ts").StackError>;
  readonly list: Effect.Effect<
    ReadonlyArray<AnyServiceDescriptor>,
    import("./Errors.ts").StackError
  >;
}

export {
  AnalyticsSettingsSchema,
  AuthSettingsSchema,
  DatabaseSettingsSchema,
  FunctionsSettingsSchema,
  MailSettingsSchema,
  PoolerSettingsSchema,
  RealtimeSettingsSchema,
  RestSettingsSchema,
  StorageSettingsSchema,
  StudioSettingsSchema,
  ServiceInstanceIdSchema,
};
