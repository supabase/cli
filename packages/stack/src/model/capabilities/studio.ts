import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";

const version = catalogEntryFor("studio:studio").defaultVersion;

const Secret = Schema.Redacted(Schema.String);
export const StudioSettingsSchema = Schema.Struct({
  api_url: Schema.optionalKey(Schema.String),
  openai_api_key: Schema.optionalKey(Secret),
});
export type StudioSettings = Schema.Schema.Type<typeof StudioSettingsSchema>;
export const StudioModule: CapabilityModule<StudioSettings> = {
  name: "studio",
  settings: StudioSettingsSchema,
  defaultSettings: { api_url: "", openai_api_key: undefined },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: version,
  dependencies: ["rest", "analytics"],
  releases: {
    [version]: release(version, [
      workload("studio", "studio", {
        dependencies: ["studio:pgmeta", "analytics:analytics"],
        readiness: { portField: "studio" },
      }),
      workload("pgmeta", "studio", {
        dependencies: ["database:database"],
        readiness: {},
      }),
    ]),
  },
  routes: [{ listener: "studio", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
};
