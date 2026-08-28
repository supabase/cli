import { Schema } from "effect";
import { identityMaterialize, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Bucket = Schema.Struct({
  public: Schema.optionalKey(Schema.Boolean),
  file_size_limit: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  allowed_mime_types: Schema.optionalKey(Schema.Array(Schema.String)),
  objects_path: Schema.optionalKey(Schema.String),
});
const Analytics = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  max_namespaces: Schema.optionalKey(Schema.Finite),
  max_tables: Schema.optionalKey(Schema.Finite),
  max_catalogs: Schema.optionalKey(Schema.Finite),
  buckets: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({}))),
});
const Vector = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  max_buckets: Schema.optionalKey(Schema.Finite),
  max_indexes: Schema.optionalKey(Schema.Finite),
  buckets: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({}))),
});
export const StorageSettingsSchema = Schema.Struct({
  file_size_limit: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  image_transformation: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
  ),
  buckets: Schema.optionalKey(Schema.Record(Schema.String, Bucket)),
  s3_protocol: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
  analytics: Schema.optionalKey(Analytics),
  vector: Schema.optionalKey(Vector),
});
export type StorageSettings = Schema.Schema.Type<typeof StorageSettingsSchema>;

export const StorageModule: CapabilityModule<StorageSettings> = {
  name: "storage",
  settings: StorageSettingsSchema,
  defaultSettings: {
    file_size_limit: "50MiB",
    image_transformation: { enabled: false },
    buckets: {},
    s3_protocol: { enabled: true },
    analytics: { enabled: false, max_namespaces: 5, max_tables: 10, max_catalogs: 2, buckets: {} },
    vector: { enabled: true, max_buckets: 10, max_indexes: 5, buckets: {} },
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  dependencies: ["database"],
  workloads: [
    workload("storage", "storage", "v1.71.0", "supabase/storage-api:v1.71.0", {
      dependencies: ["database:database", "storage:imgproxy"],
      readiness: { mode: "http", portField: "api" },
    }),
    workload("imgproxy", "storage", "v3.8.0", "darthsim/imgproxy:v3.8.0", {
      dependencies: ["database:database"],
      readiness: { mode: "http" },
    }),
  ],
  routes: [{ listener: "api", protocol: "http" }],
  materialize: (settings) => identityMaterialize(settings),
  runtimeArtifact: (entry, runtime) =>
    runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
};
