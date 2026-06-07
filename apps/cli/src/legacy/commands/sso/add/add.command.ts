import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySsoAdd } from "./add.handler.ts";

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
  // Required per Go's `MarkFlagRequired("type")` in `cmd/sso.go:65` — leave
  // off `Flag.optional` so the CLI parser enforces presence at parse time.
  type: Flag.choice("type", ["saml"] as const).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Type of identity provider (according to supported protocol)."),
  ),
  domains: Flag.string("domains").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Comma separated list of email domains to associate with the added identity provider.",
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
};
export type LegacySsoAddFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySsoAddCommand = Command.make("add", config).pipe(
  Command.withDescription(
    "Add and configure a new connection to a SSO identity provider to your Supabase project.",
  ),
  Command.withShortDescription("Add a new SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso add --type saml --project-ref mwjylndxudmiehsxhmmz --metadata-url 'https://...' --domains example.com",
      description: "Add a new SAML SSO provider",
    },
  ]),
  Command.withHandler((flags) =>
    legacySsoAdd(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["sso", "add"])),
);
