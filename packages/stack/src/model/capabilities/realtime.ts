import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";

const version = catalogEntryFor("realtime:realtime").defaultVersion;

const Secret = Schema.Redacted(Schema.String);

export const RealtimeSettingsSchema = Schema.Struct({
  ip_version: Schema.optionalKey(Schema.Literals(["IPv4", "IPv6"] as const)),
  max_header_length: Schema.optionalKey(Schema.Finite),
  db_enc_key: Schema.optionalKey(Secret),
  secret_key_base: Schema.optionalKey(Secret),
});
export type RealtimeSettings = Schema.Schema.Type<typeof RealtimeSettingsSchema>;

export const RealtimeModule: CapabilityModule<RealtimeSettings> = {
  name: "realtime",
  settings: RealtimeSettingsSchema,
  defaultSettings: {
    ip_version: "IPv4",
    max_header_length: 4096,
    db_enc_key: undefined,
    secret_key_base: undefined,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: version,
  dependencies: ["database"],
  releases: {
    [version]: release(version, [
      workload("realtime", "realtime", {
        dependencies: ["database:database"],
        readiness: { portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: (path) =>
    path === "realtime.settings.db_enc_key" || path === "realtime.settings.secret_key_base"
      ? "managed"
      : "passthrough",
  managedSecretSlots: ["realtime.settings.db_enc_key", "realtime.settings.secret_key_base"],
};
