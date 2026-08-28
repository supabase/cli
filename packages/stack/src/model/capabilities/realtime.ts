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
  defaultVersion: "v2.129.9",
  dependencies: ["database"],
  releases: {
    "v2.129.9": release("v2.129.9", [
      workload("realtime", "realtime", "v2.129.9", "supabase/realtime:v2.129.9", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  materialize: (settings) => settings,
};
