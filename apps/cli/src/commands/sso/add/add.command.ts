import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { SSO_NAME_ID_FORMATS } from "../sso.saml.ts";
import { ssoAdd } from "./add.handler.ts";

// `--domains` is a CSV string-slice flag; malformed CSV fails at parse time
// with pflag's exact diagnostic (see `stringSliceFlag`).
export const ssoAddDomainsFlag = stringSliceFlag(
  "domains",
  "Comma separated list of email domains to associate with the added identity provider.",
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  // `--type` is required — leave off `Flag.optional` so the CLI parser
  // enforces presence at parse time.
  type: Flag.choice("type", ["saml"] as const).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Type of identity provider (according to supported protocol)."),
  ),
  domains: ssoAddDomainsFlag,
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
};
export type SsoAddFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoAddCommand = Command.make("add", config).pipe(
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
    ssoAdd(flags).pipe(
      withCommandTelemetry({
        flags,
        safeFlags: ["project-ref"],
        config,
        // `--type` registers `-t` (Flag.withAlias above); without this, `-t saml`
        // never resolves to the canonical `type` name in extractChangedFlagNames,
        // so it wouldn't appear in telemetry at all — the canonical name must be
        // reported regardless of shorthand.
        aliases: { t: "type" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "add"])),
);
