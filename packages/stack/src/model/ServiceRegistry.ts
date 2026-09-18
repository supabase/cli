import { Effect, Schema, SchemaGetter } from "effect";
import type { MaterializedCapabilities } from "./ExecutionPlan.ts";
import { validateMaterializedSettingsByName } from "../state/MaterializedSettingsValidation.ts";
import {
  ServiceInstanceIdSchema,
  ServiceKindSchema,
  SERVICE_KINDS,
  type ServiceKind,
  OptionalEndpointIntentSchema,
  SnapshotDescriptorSchema,
} from "../public/Service.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import {
  ServiceDependencyError,
  ServiceNameConflictError,
  ServiceNotFoundError,
} from "../public/Errors.ts";
import { ActivationModeSchema } from "../public/Capability.ts";

const ServiceResourceIdentitySchema = Schema.Struct({
  runtime: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  alias: Schema.optionalKey(Schema.String),
});
export type ServiceResourceIdentity = Schema.Schema.Type<typeof ServiceResourceIdentitySchema>;

const InitializationRecipeSchema = Schema.Struct({
  service: ServiceKindSchema,
  recipeId: Schema.String.check(Schema.isNonEmpty()),
  artifactIdentity: Schema.String,
  completed: Schema.Boolean,
});
const ServiceInitializationEvidenceSchema = Schema.Struct({
  profileId: Schema.String,
  recipes: Schema.Array(InitializationRecipeSchema),
});
export type ServiceInitializationEvidence = Schema.Schema.Type<
  typeof ServiceInitializationEvidenceSchema
>;

const ServiceDataStateSchema = Schema.Union([
  Schema.Struct({ origin: Schema.Literal("absent") }),
  Schema.Struct({ origin: Schema.Literal("fresh"), lineageId: Schema.String }),
  Schema.Struct({ origin: Schema.Literal("restored"), snapshot: SnapshotDescriptorSchema }),
  Schema.Struct({ origin: Schema.Literal("incomplete"), operationId: Schema.String }),
]);
type ServiceDataState = Schema.Schema.Type<typeof ServiceDataStateSchema>;

const ServiceRevisionsSchema = Schema.Struct({
  config: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  intent: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** Durable operation journal; public status intentionally exposes only id and kind. */
const PersistedPendingOperationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  kind: Schema.Literals([
    "start",
    "sleep",
    "stop",
    "restart",
    "destroy",
    "exportSnapshot",
    "restoreSnapshot",
  ] as const),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ownerSessionId: Schema.String.check(Schema.isNonEmpty()),
  phase: Schema.Literals(["admitted", "running", "settling", "cleanup", "complete"] as const),
  stagingPath: Schema.optionalKey(Schema.String),
  outputPath: Schema.optionalKey(Schema.String),
  helperId: Schema.optionalKey(Schema.String),
  sourceInstanceId: Schema.optionalKey(ServiceInstanceIdSchema),
});
export type PersistedPendingOperation = Schema.Schema.Type<typeof PersistedPendingOperationSchema>;

type MaterializedSettingsFor<K extends ServiceKind> = MaterializedCapabilities[K]["settings"];
type Endpoint = Schema.Schema.Type<typeof OptionalEndpointIntentSchema>;
export type PersistedServiceEndpoints = {
  database: { readonly sql?: Endpoint };
  rest: Record<never, never>;
  auth: Record<never, never>;
  realtime: Record<never, never>;
  storage: Record<never, never>;
  functions: { readonly inspector?: Endpoint };
  studio: { readonly studio?: Endpoint };
  mail: { readonly smtp?: Endpoint; readonly pop3?: Endpoint; readonly mailUi?: Endpoint };
  analytics: Record<never, never>;
  pooler: { readonly pooler?: Endpoint };
};

type PersistedServiceConfigMap = {
  [K in ServiceKind]: {
    readonly enabled: boolean;
    readonly activation: Schema.Schema.Type<typeof ActivationModeSchema>;
    readonly idleTimeoutSeconds: K extends
      | "database"
      | "storage"
      | "functions"
      | "mail"
      | "analytics"
      ? false
      : number | false;
    readonly version: string;
    readonly settings: MaterializedSettingsFor<K>;
    readonly endpoints: PersistedServiceEndpoints[K];
    readonly passwordSecretRef?: K extends "database" ? string : never;
  };
};
type PersistedServiceConfig<K extends ServiceKind = ServiceKind> = PersistedServiceConfigMap[K];
const materializedSettingsSchema = <K extends ServiceKind>(service: K) =>
  Schema.declareConstructor<MaterializedSettingsFor<K>>()(
    [],
    () => (input, _ast, options) => validateMaterializedSettingsByName(service, input, options),
  );

const endpointSchema = <const Fields extends Record<string, Schema.Top>>(fields: Fields) =>
  Schema.Struct(fields);
const endpointSchemas = {
  database: endpointSchema({ sql: Schema.optionalKey(OptionalEndpointIntentSchema) }),
  rest: endpointSchema({}),
  auth: endpointSchema({}),
  realtime: endpointSchema({}),
  storage: endpointSchema({}),
  functions: endpointSchema({
    inspector: Schema.optionalKey(OptionalEndpointIntentSchema),
  }),
  studio: endpointSchema({ studio: Schema.optionalKey(OptionalEndpointIntentSchema) }),
  mail: endpointSchema({
    smtp: Schema.optionalKey(OptionalEndpointIntentSchema),
    pop3: Schema.optionalKey(OptionalEndpointIntentSchema),
    mailUi: Schema.optionalKey(OptionalEndpointIntentSchema),
  }),
  analytics: endpointSchema({}),
  pooler: endpointSchema({ pooler: Schema.optionalKey(OptionalEndpointIntentSchema) }),
} satisfies { readonly [K in ServiceKind]: Schema.Top };

const configSchema = <K extends ServiceKind, I extends Schema.Top>(service: K, idle: I) =>
  Schema.Struct({
    enabled: Schema.Boolean,
    activation: ActivationModeSchema,
    idleTimeoutSeconds: idle,
    version: Schema.String.check(Schema.isNonEmpty()),
    settings: materializedSettingsSchema(service),
    endpoints: endpointSchemas[service],
  });

const retirableIdle = Schema.Union([
  Schema.Literal(false),
  Schema.Finite.check(Schema.isGreaterThan(0)),
]);
const configSchemas = {
  database: Schema.Struct({
    enabled: Schema.Boolean,
    activation: ActivationModeSchema,
    idleTimeoutSeconds: Schema.Literal(false),
    version: Schema.String.check(Schema.isNonEmpty()),
    settings: materializedSettingsSchema("database"),
    endpoints: endpointSchemas.database,
    passwordSecretRef: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  }),
  rest: configSchema("rest", retirableIdle),
  auth: configSchema("auth", retirableIdle),
  realtime: configSchema("realtime", retirableIdle),
  storage: configSchema("storage", Schema.Literal(false)),
  functions: configSchema("functions", Schema.Literal(false)),
  studio: configSchema("studio", retirableIdle),
  mail: configSchema("mail", Schema.Literal(false)),
  analytics: configSchema("analytics", Schema.Literal(false)),
  pooler: configSchema("pooler", retirableIdle),
} satisfies { readonly [K in ServiceKind]: Schema.Top };
const dependencySchemas = {
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
} satisfies { readonly [K in ServiceKind]: Schema.Top };

const catalogInputSchema = <K extends ServiceKind>(service: K) =>
  Schema.Struct({
    version: Schema.String.check(Schema.isNonEmpty()),
    settings: materializedSettingsSchema(service),
  });
export const ServiceInitializationInputsSchema = Schema.Struct({
  profileId: Schema.String.check(Schema.isNonEmpty()),
  catalog: Schema.Struct({
    auth: Schema.optionalKey(catalogInputSchema("auth")),
    storage: Schema.optionalKey(catalogInputSchema("storage")),
    realtime: Schema.optionalKey(catalogInputSchema("realtime")),
    analytics: Schema.optionalKey(catalogInputSchema("analytics")),
    pooler: Schema.optionalKey(catalogInputSchema("pooler")),
  }),
});
export type ServiceInitializationInputs = Schema.Schema.Type<
  typeof ServiceInitializationInputsSchema
>;

type PersistedServiceInstanceBase = {
  readonly id: ServiceInstanceId;
  readonly name?: string;
  readonly intent: "started" | "stopped";
  readonly dependencies: Readonly<Record<string, ServiceInstanceId>>;
  readonly resources: ServiceResourceIdentity;
  readonly revisions: Schema.Schema.Type<typeof ServiceRevisionsSchema>;
  readonly pendingOperation: PersistedPendingOperation | null;
  readonly initialization: ServiceInitializationEvidence | null;
  readonly initializationInputs: ServiceInitializationInputs | null;
  readonly data: ServiceDataState;
  readonly artifactIdentity?: string;
  readonly runtimeIdentity?: string;
  readonly bootstrapRecipeId?: string;
  readonly bootstrapInputsId?: string;
  readonly creationInputsId?: string;
};
export type PersistedServiceInstanceFor<K extends ServiceKind> = {
  [K in ServiceKind]: Omit<PersistedServiceInstanceBase, "service" | "config"> & {
    readonly service: K;
    readonly config: PersistedServiceConfig<K>;
  };
}[K];
const instanceSchema = <K extends ServiceKind>(service: K) =>
  Schema.Struct({
    id: ServiceInstanceIdSchema,
    service: Schema.Literal(service),
    name: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
    intent: Schema.Literals(["stopped", "started"] as const),
    config: configSchemas[service],
    dependencies: dependencySchemas[service],
    resources: ServiceResourceIdentitySchema,
    revisions: ServiceRevisionsSchema,
    pendingOperation: Schema.NullOr(PersistedPendingOperationSchema),
    initialization: Schema.NullOr(ServiceInitializationEvidenceSchema),
    initializationInputs: Schema.NullOr(ServiceInitializationInputsSchema),
    data: ServiceDataStateSchema,
    artifactIdentity: Schema.optionalKey(Schema.String),
    runtimeIdentity: Schema.optionalKey(Schema.String),
    bootstrapRecipeId: Schema.optionalKey(Schema.String),
    bootstrapInputsId: Schema.optionalKey(Schema.String),
    creationInputsId: Schema.optionalKey(Schema.String),
  });

export const PersistedServiceInstanceSchema = Schema.Union([
  instanceSchema("database"),
  instanceSchema("rest"),
  instanceSchema("auth"),
  instanceSchema("realtime"),
  instanceSchema("storage"),
  instanceSchema("functions"),
  instanceSchema("studio"),
  instanceSchema("mail"),
  instanceSchema("analytics"),
  instanceSchema("pooler"),
]);

export type PersistedServiceInstance = Schema.Schema.Type<typeof PersistedServiceInstanceSchema>;

const uniqueInstances = Schema.Array(PersistedServiceInstanceSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((instances) => {
      const ids = instances.map(({ id }) => id);
      const names = instances.flatMap(({ name }) => (name === undefined ? [] : [name]));
      return Effect.succeed(
        new Set(ids).size === ids.length && new Set(names).size === names.length
          ? undefined
          : "Service instance IDs and names must be unique",
      );
    }),
    encode: SchemaGetter.passthrough(),
  }),
);

const registryShape = Schema.Struct({
  initialized: Schema.Boolean,
  instances: uniqueInstances,
  defaultInstanceIds: Schema.Record(Schema.String, ServiceInstanceIdSchema),
});
export const PersistedServiceRegistrySchema = registryShape.pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((registry) => {
      for (const [kind, id] of Object.entries(registry.defaultInstanceIds)) {
        if (!SERVICE_KINDS.some((candidate) => candidate === kind))
          return Effect.succeed(`Unknown default service kind ${kind}`);
        const instance = registry.instances.find((entry) => entry.id === id);
        if (instance === undefined || instance.service !== kind)
          return Effect.succeed(`Default service ${kind} references an invalid instance ${id}`);
      }
      return Effect.succeed(true);
    }),
    encode: SchemaGetter.passthrough(),
  }),
);
export type PersistedServiceRegistry = Schema.Schema.Type<typeof PersistedServiceRegistrySchema>;

export const emptyServiceRegistry = (): PersistedServiceRegistry => ({
  initialized: true,
  instances: [],
  defaultInstanceIds: {},
});

const dependencyKinds: Readonly<Record<ServiceKind, ReadonlyArray<ServiceKind>>> = {
  database: [],
  rest: ["database"],
  auth: ["database"],
  realtime: ["database"],
  storage: ["database"],
  functions: [],
  studio: ["database", "rest", "analytics"],
  mail: [],
  analytics: ["database"],
  pooler: ["database"],
};

const instanceNotFound = (id: ServiceInstanceId): ServiceNotFoundError =>
  new ServiceNotFoundError({ message: `Service instance ${id} was not found`, instanceId: id });

const validateServiceDependencies = (
  registry: PersistedServiceRegistry,
  instance: {
    readonly service: ServiceKind;
    readonly dependencies: Readonly<Record<string, ServiceInstanceId>>;
  },
): Effect.Effect<void, ServiceDependencyError> => {
  const byId = new Map(registry.instances.map((entry) => [entry.id, entry]));
  for (const kind of dependencyKinds[instance.service]) {
    const id = instance.dependencies[kind];
    if (id === undefined)
      return Effect.fail(
        new ServiceDependencyError({
          message: `${instance.service} requires a ${kind} dependency`,
          service: instance.service,
          dependency: kind,
        }),
      );
    const dependency = byId.get(id);
    if (dependency === undefined)
      return Effect.fail(
        new ServiceDependencyError({
          message: `${instance.service} references missing dependency ${id}`,
          service: instance.service,
          dependency: kind,
        }),
      );
    if (dependency.service !== kind)
      return Effect.fail(
        new ServiceDependencyError({
          message: `${instance.service} dependency ${id} is ${dependency.service}, expected ${kind}`,
          service: instance.service,
          dependency: kind,
        }),
      );
  }
  return Effect.void;
};

const hasDependencyCycle = (
  registry: PersistedServiceRegistry,
  candidate: PersistedServiceInstance,
): boolean => {
  const byId = new Map(registry.instances.map((entry) => [entry.id, entry]));
  byId.set(candidate.id, candidate);
  const visiting = new Set<ServiceInstanceId>();
  const visited = new Set<ServiceInstanceId>();
  const visit = (id: ServiceInstanceId): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const entry = byId.get(id);
    if (entry !== undefined)
      for (const dependency of Object.values(entry.dependencies))
        if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(candidate.id);
};

export const registerServiceInstance = (
  registry: PersistedServiceRegistry,
  instance: PersistedServiceInstance,
): Effect.Effect<PersistedServiceRegistry, ServiceDependencyError | ServiceNameConflictError> => {
  if (registry.instances.some(({ id }) => id === instance.id))
    return Effect.fail(
      new ServiceNameConflictError({ message: `Service instance ${instance.id} already exists` }),
    );
  if (instance.name !== undefined && registry.instances.some(({ name }) => name === instance.name))
    return Effect.fail(
      new ServiceNameConflictError({ message: `Service name ${instance.name} already exists` }),
    );
  return validateServiceDependencies(registry, instance).pipe(
    Effect.flatMap(() =>
      hasDependencyCycle(registry, instance)
        ? Effect.fail(new ServiceDependencyError({ message: "Service dependency cycle detected" }))
        : Effect.succeed({ ...registry, instances: [...registry.instances, instance] }),
    ),
  );
};

export const removeServiceInstance = (
  registry: PersistedServiceRegistry,
  id: ServiceInstanceId,
): Effect.Effect<PersistedServiceRegistry, ServiceDependencyError | ServiceNotFoundError> => {
  if (!registry.instances.some((entry) => entry.id === id))
    return Effect.fail(instanceNotFound(id));
  const dependent = registry.instances.find((entry) =>
    Object.values(entry.dependencies).includes(id),
  );
  if (dependent !== undefined)
    return Effect.fail(
      new ServiceDependencyError({
        message: `Cannot remove ${id}; ${dependent.id} depends on it`,
        dependency: id,
      }),
    );
  return Effect.succeed({
    ...registry,
    instances: registry.instances.filter((entry) => entry.id !== id),
    defaultInstanceIds: Object.fromEntries(
      Object.entries(registry.defaultInstanceIds).filter(([, instanceId]) => instanceId !== id),
    ),
  });
};
