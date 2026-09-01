import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

export const RealtimeSettingsSchema = Schema.Struct({
  ip_version: Schema.optionalKey(Schema.Literals(["IPv4", "IPv6"] as const)),
  max_header_length: Schema.optionalKey(Schema.Finite),
});
export type RealtimeSettings = Schema.Schema.Type<typeof RealtimeSettingsSchema>;

export const RealtimeModule: CapabilityModule<RealtimeSettings> = {
  name: "realtime",
  settings: RealtimeSettingsSchema,
  defaultSettings: { ip_version: "IPv4", max_header_length: 4096 },
  defaultEnabled: true,
  defaultActivation: "eager",
  defaultVersion: "v2.130.0",
  dependencies: ["database"],
  releases: {
    "v2.130.0": release("v2.130.0", [
      workload("realtime", "realtime", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
};
