import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

const Secret = Schema.Redacted(Schema.String);
export const StudioSettingsSchema = Schema.Struct({
  api_url: Schema.optionalKey(Schema.String),
  openai_api_key: Schema.optionalKey(Secret),
});
export type StudioSettings = Schema.Schema.Type<typeof StudioSettingsSchema>;
export const StudioModule: CapabilityModule<StudioSettings> = {
  name: "studio",
  settings: StudioSettingsSchema,
  defaultSettings: { api_url: "http://127.0.0.1", openai_api_key: undefined },
  defaultEnabled: true,
  defaultActivation: "eager",
  defaultVersion: "2026.08.24-sha-8ec45b2",
  dependencies: ["rest", "analytics"],
  releases: {
    "2026.08.24-sha-8ec45b2": release("2026.08.24-sha-8ec45b2", [
      workload(
        "studio",
        "studio",
        "2026.08.24-sha-8ec45b2",
        "supabase/studio:2026.08.24-sha-8ec45b2",
        {
          dependencies: ["studio:pgmeta", "analytics:analytics"],
          readiness: { mode: "http", portField: "studio" },
        },
      ),
      workload("pgmeta", "studio", "0.98.0", "supabase/pg-meta:v0.98.0", {
        dependencies: ["database:database"],
        readiness: { mode: "http" },
      }),
    ]),
  },
  routes: [{ listener: "studio", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
  materialize: (settings) => settings,
};
