import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySsoUpdate } from "./update.handler.ts";

const NAME_ID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
] as const;

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  domains: Flag.string("domains").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Replace domains with this comma separated list of email domains."),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  addDomains: Flag.string("add-domains").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Add this comma separated list of email domains to the identity provider.",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  removeDomains: Flag.string("remove-domains").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Remove this comma separated list of email domains from the identity provider.",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
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
  ),
  attributeMappingFile: Flag.string("attribute-mapping-file").pipe(
    Flag.withDescription(
      "File containing a JSON mapping between SAML attributes to custom JWT claims.",
    ),
    Flag.optional,
  ),
  nameIdFormat: Flag.choice("name-id-format", NAME_ID_FORMATS).pipe(
    Flag.withDescription(
      "URI reference representing the classification of string-based identifier information.",
    ),
    Flag.optional,
  ),
  providerId: Argument.string("provider-id").pipe(
    Argument.withDescription("The ID of the SSO identity provider to update."),
  ),
};
export type LegacySsoUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySsoUpdateCommand = Command.make("update", config).pipe(
  // Mirrors Go's long description verbatim, including the `of a already added`
  // grammar slip in `apps/cli-go/cmd/sso.go`. Strict 1:1 port — file a Go-side
  // fix upstream rather than diverging here.
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
    legacySsoUpdate(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["sso", "update"])),
);
