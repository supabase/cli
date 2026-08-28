import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

export const RestSettingsSchema = Schema.Struct({
  schemas: Schema.optionalKey(Schema.Array(Schema.String)),
  extra_search_path: Schema.optionalKey(Schema.Array(Schema.String)),
  max_rows: Schema.optionalKey(Schema.Finite),
  auto_expose_new_tables: Schema.optionalKey(Schema.Boolean),
  tls: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      cert_path: Schema.optionalKey(Schema.String),
      key_path: Schema.optionalKey(Schema.String),
    }),
  ),
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
    auto_expose_new_tables: undefined,
    tls: { enabled: false, cert_path: undefined, key_path: undefined },
    external_url: undefined,
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: "v16.2",
  dependencies: ["database"],
  releases: {
    "v16.2": release("v16.2", [
      workload("rest", "rest", "v16.2", "postgrest/postgrest:v16.2", {
        dependencies: ["database:database"],
        readiness: { mode: "http", portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
  materialize: (settings) => settings,
};
