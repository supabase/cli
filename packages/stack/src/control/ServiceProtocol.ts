import { Schema } from "effect";
import {
  ServiceInstanceIdSchema,
  ServiceKindSchema,
  SnapshotDescriptorSchema,
} from "../public/Service.ts";
import {
  ApiCredentialsSchema,
  DatabaseCredentialsSchema,
  EmptyServiceCredentialsSchema,
  StorageCredentialsSchema,
} from "../public/Credentials.ts";
import { NetworkPortSchema, ServiceStatusSchema } from "../public/Status.ts";

const ServiceEndpointSchema = Schema.Struct({
  address: Schema.String,
  port: NetworkPortSchema,
  url: Schema.String,
  protocol: Schema.optionalKey(Schema.Literals(["http", "tcp"] as const)),
  enabled: Schema.optionalKey(Schema.Boolean),
});

const ServiceDataSchema = Schema.Union([
  Schema.Struct({ origin: Schema.Literal("absent") }),
  Schema.Struct({ origin: Schema.Literal("fresh"), lineageId: Schema.String }),
  Schema.Struct({ origin: Schema.Literal("restored"), snapshot: SnapshotDescriptorSchema }),
  Schema.Struct({ origin: Schema.Literal("incomplete"), operationId: Schema.String }),
]);

const ServiceInitializationSchema = Schema.Struct({
  profileId: Schema.String,
  recipes: Schema.Array(
    Schema.Struct({
      service: ServiceKindSchema,
      recipeId: Schema.String,
      artifactIdentity: Schema.String,
      completed: Schema.Boolean,
    }),
  ),
});

/** Wire representation of a materialized registered service instance. */
export const ServiceDescriptorSchema = Schema.Struct({
  id: ServiceInstanceIdSchema,
  service: ServiceKindSchema,
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  config: Schema.Struct({
    enabled: Schema.Boolean,
    activation: Schema.Literals(["eager", "lazy"] as const),
    idleTimeoutSeconds: Schema.Union([Schema.Literal(false), Schema.Finite]),
    version: Schema.String,
    settings: Schema.Record(Schema.String, Schema.Unknown),
  }),
  dependencies: Schema.Record(Schema.String, ServiceInstanceIdSchema),
  snapshotSupport: Schema.Literals(["supported", "unsupported"] as const),
  endpoints: Schema.Record(Schema.String, ServiceEndpointSchema),
  artifactIdentity: Schema.optionalKey(Schema.String),
  runtimeIdentity: Schema.optionalKey(Schema.String),
  effectiveConfigFingerprint: Schema.optionalKey(Schema.String),
  initializationProfileId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bootstrapRecipeId: Schema.optionalKey(Schema.String),
  bootstrapInputsId: Schema.optionalKey(Schema.String),
  creationInputsId: Schema.optionalKey(Schema.String),
  initialization: Schema.optionalKey(ServiceInitializationSchema),
  data: ServiceDataSchema,
});

export const ServiceDescriptorListSchema = Schema.Array(ServiceDescriptorSchema);

export const PrepareResultSchema = Schema.Struct({
  instances: Schema.Array(
    Schema.Struct({
      id: ServiceInstanceIdSchema,
      service: ServiceKindSchema,
      artifacts: Schema.Array(
        Schema.Struct({
          identity: Schema.String,
          outcome: Schema.Literals(["cached", "downloaded", "pulled"] as const),
        }),
      ),
      effectiveConfigFingerprint: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** Service credentials are optional for services without a credential projection. */
export const ServiceCredentialsSchema = Schema.Union([
  Schema.Undefined,
  DatabaseCredentialsSchema,
  ApiCredentialsSchema,
  StorageCredentialsSchema,
  EmptyServiceCredentialsSchema,
]);

export { ServiceStatusSchema, SnapshotDescriptorSchema };
