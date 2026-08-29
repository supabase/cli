import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Bucket = Schema.Struct({
  public: Schema.optionalKey(Schema.Boolean),
  file_size_limit: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  allowed_mime_types: Schema.optionalKey(Schema.Array(Schema.String)),
  objects_path: Schema.optionalKey(Schema.String),
});
const Secret = Schema.Redacted(Schema.String);
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
  s3_protocol: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      region: Schema.optionalKey(Schema.String),
      access_key_id: Schema.optionalKey(Schema.String),
      secret_access_key: Schema.optionalKey(Secret),
    }),
  ),
  analytics: Schema.optionalKey(Analytics),
  vector: Schema.optionalKey(Vector),
});
export type StorageSettings = Schema.Schema.Type<typeof StorageSettingsSchema>;

const FILE_SIZE_UNITS: Readonly<Record<string, bigint>> = {
  B: 1n,
  KB: 1_000n,
  MB: 1_000_000n,
  GB: 1_000_000_000n,
  TB: 1_000_000_000_000n,
  KiB: 1_024n,
  MiB: 1_048_576n,
  GiB: 1_073_741_824n,
  TiB: 1_099_511_627_776n,
};
const MAX_FILE_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert one non-negative byte size into its exact decimal representation. */
export const parseFileSize = (value: string | number): string | undefined => {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)[ \t]*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/u.exec(
    String(value).trim(),
  );
  if (match === null) return undefined;
  const amount = match[1];
  const unit = match[2] ?? "B";
  if (amount === undefined) return undefined;
  const factor = FILE_SIZE_UNITS[unit];
  if (factor === undefined) return undefined;
  const [whole, fraction = ""] = amount.split(".");
  if (whole === undefined) return undefined;
  const scale = 10n ** BigInt(fraction.length);
  const scaled = (BigInt(whole) * scale + BigInt(fraction || "0")) * factor;
  if (scaled % scale !== 0n) return undefined;
  const bytes = scaled / scale;
  return bytes > MAX_FILE_SIZE ? undefined : bytes.toString();
};

const bucketDefaults = {
  public: false,
  file_size_limit: "50MiB",
  allowed_mime_types: [],
  objects_path: "",
};

export const StorageModule: CapabilityModule<StorageSettings> = {
  name: "storage",
  settings: StorageSettingsSchema,
  defaultSettings: {
    file_size_limit: "50MiB",
    image_transformation: { enabled: false },
    buckets: {},
    s3_protocol: {
      enabled: true,
      region: "local",
      access_key_id: "625729a08b95bf1b7ff351a663f3a23c",
      // Managed by the compiler so every stack receives a fresh credential.
      secret_access_key: undefined,
    },
    analytics: { enabled: false, max_namespaces: 5, max_tables: 10, max_catalogs: 2, buckets: {} },
    vector: { enabled: true, max_buckets: 10, max_indexes: 5, buckets: {} },
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: "v1.71.0",
  dependencies: ["database"],
  releases: {
    "v1.71.0": release("v1.71.0", [
      workload("storage", "storage", "v1.71.0", "ghcr.io/supabase/cli/storage:v1.71.0", {
        dependencies: ["database:database", "storage:imgproxy"],
        readiness: { mode: "http", portField: "api" },
      }),
      workload("imgproxy", "storage", "v3.8.0", "darthsim/imgproxy:v3.8.0", {
        dependencies: ["database:database"],
        readiness: { mode: "http" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: (path) =>
    path === "storage.settings.s3_protocol.secret_access_key" ? "managed" : "passthrough",
  managedSecretSlots: ["storage.settings.s3_protocol.secret_access_key"],
  selectWorkloads: (settings, workloads) => {
    const record = (value: unknown): Record<string, unknown> | undefined =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
    const value = record(settings)?.image_transformation;
    const enabled = record(value)?.enabled === true;
    return workloads
      .filter((entry) => enabled || entry.name !== "imgproxy")
      .map((entry) =>
        entry.name === "storage"
          ? {
              ...entry,
              dependencies: enabled
                ? [
                    ...entry.dependencies.filter((dependency) => dependency !== "storage:imgproxy"),
                    "storage:imgproxy",
                  ]
                : entry.dependencies.filter((dependency) => dependency !== "storage:imgproxy"),
            }
          : entry,
      );
  },
  materialize: (settings) => ({
    ...settings,
    buckets: Object.fromEntries(
      Object.entries(settings.buckets ?? {}).map(([name, bucket]) => [
        name,
        { ...bucketDefaults, ...bucket },
      ]),
    ),
  }),
};
