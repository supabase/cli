import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";

const version = catalogEntryFor("rest:rest").defaultVersion;

export const RestSettingsSchema = Schema.Struct({
  schemas: Schema.optionalKey(Schema.Array(Schema.String)),
  extra_search_path: Schema.optionalKey(Schema.Array(Schema.String)),
  max_rows: Schema.optionalKey(Schema.Finite),
  external_url: Schema.optionalKey(Schema.String),
});
export type RestSettings = Schema.Schema.Type<typeof RestSettingsSchema>;

export const RestModule: CapabilityModule<RestSettings> = {
  name: "rest",
  settings: RestSettingsSchema,
  defaultSettings: {
    schemas: ["public", "graphql_public"],
    extra_search_path: ["public", "extensions"],
    max_rows: 1000,
    external_url: undefined,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultIdleTimeoutSeconds: 60,
  defaultVersion: version,
  dependencies: ["database"],
  releases: {
    [version]: release(version, [
      workload("rest", "rest", {
        dependencies: ["database:database"],
        readiness: { portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
};
