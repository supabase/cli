import { Schema } from "effect";
import { identityMaterialize, workload, type CapabilityModule } from "../CapabilityModule.ts";

export const MailSettingsSchema = Schema.Struct({
  admin_email: Schema.optionalKey(Schema.String),
  sender_name: Schema.optionalKey(Schema.String),
});
export type MailSettings = Schema.Schema.Type<typeof MailSettingsSchema>;
export const MailModule: CapabilityModule<MailSettings> = {
  name: "mail",
  settings: MailSettingsSchema,
  defaultSettings: { admin_email: undefined, sender_name: undefined },
  defaultEnabled: true,
  defaultActivation: "eager",
  dependencies: [],
  workloads: [
    workload("mail", "mail", "v1.30.2", "axllent/mailpit:v1.30.2", {
      readiness: { mode: "http", portField: "mailUi" },
    }),
  ],
  routes: [
    { listener: "mailUi", protocol: "http" },
    { listener: "smtp", protocol: "tcp" },
    { listener: "pop3", protocol: "tcp" },
  ],
  materialize: (settings) => identityMaterialize(settings),
  runtimeArtifact: (entry, runtime) =>
    runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
};
