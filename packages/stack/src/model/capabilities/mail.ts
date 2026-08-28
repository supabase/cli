import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";

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
  defaultVersion: "v1.30.2",
  dependencies: [],
  releases: {
    "v1.30.2": release("v1.30.2", [
      workload("mail", "mail", "v1.30.2", "axllent/mailpit:v1.30.2", {
        readiness: { mode: "http", portField: "mailUi" },
      }),
    ]),
  },
  routes: [
    { listener: "mailUi", protocol: "http" },
    { listener: "smtp", protocol: "tcp" },
    { listener: "pop3", protocol: "tcp" },
  ],
  materialize: (settings) => settings,
};
