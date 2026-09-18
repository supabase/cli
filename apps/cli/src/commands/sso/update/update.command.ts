import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { SSO_NAME_ID_FORMATS } from "../sso.saml.ts";
import { ssoUpdate } from "./update.handler.ts";

// All three domain flags are CSV string-slice flags; malformed CSV reports
// pflag's diagnostic (see `stringSliceFlag`).
export const ssoUpdateDomainsFlag = stringSliceFlag(
  "domains",
  "Replace domains with this comma separated list of email domains.",
);

export const ssoUpdateAddDomainsFlag = stringSliceFlag(
  "add-domains",
  "Add this comma separated list of email domains to the identity provider.",
);

export const ssoUpdateRemoveDomainsFlag = stringSliceFlag(
  "remove-domains",
  "Remove this comma separated list of email domains from the identity provider.",
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  domains: ssoUpdateDomainsFlag,
  addDomains: ssoUpdateAddDomainsFlag,
  removeDomains: ssoUpdateRemoveDomainsFlag,
  metadataFile: Flag.string("metadata-file").pipe(
    Flag.withDescription(
      "File containing a SAML 2.0 Metadata XML document describing the identity provider.",
    ),
    Flag.optional,
  ),
  metadataUrl: Flag.string("metadata-url").pipe(
    Flag.withDescription(
      "URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.",
    ),
    Flag.optional,
  ),
  skipUrlValidation: Flag.boolean("skip-url-validation").pipe(
    Flag.withDescription(
      "Skip local validation of the SAML 2.0 Metadata URL (HTTPS requirement, live GET probe, and UTF-8 body decode). Use in air-gapped CI where the IDP is not reachable from the build agent.",
    ),
    Flag.withDefault(false),
  ),
  attributeMappingFile: Flag.string("attribute-mapping-file").pipe(
    Flag.withDescription(
      "File containing a JSON mapping between SAML attributes to custom JWT claims.",
    ),
    Flag.optional,
  ),
  nameIdFormat: Flag.choice("name-id-format", SSO_NAME_ID_FORMATS).pipe(
    Flag.withDescription(
      "URI reference representing the classification of string-based identifier information.",
    ),
    Flag.optional,
  ),
  providerId: Argument.string("provider-id").pipe(
    Argument.withDescription("The ID of the SSO identity provider to update."),
  ),
};
export type SsoUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoUpdateCommand = Command.make("update", config).pipe(
  // The `of a already added` grammar slip is part of the established output
  // string — don't fix it here.
  Command.withDescription(
    "Update the configuration settings of a already added SSO identity provider.",
  ),
  Command.withShortDescription("Update information about an SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz --add-domains example.com",
      description: "Update an SSO provider's domains",
    },
  ]),
  Command.withHandler((flags) =>
    ssoUpdate(flags).pipe(
      withCommandTelemetry({ flags, safeFlags: ["project-ref"], config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "update"])),
);
