import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyStringSliceFlag } from "../../../shared/legacy-string-slice-flag.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LEGACY_SSO_NAME_ID_FORMATS } from "../sso.saml.ts";
import { legacySsoAdd } from "./add.handler.ts";

// Go declares `--domains` with pflag's `StringSliceVar` (`cmd/sso.go:158`);
// malformed CSV fails at parse time with pflag's exact diagnostic (CLI-2005,
// see `legacyStringSliceFlag`).
export const legacySsoAddDomainsFlag = legacyStringSliceFlag(
  "domains",
  "Comma separated list of email domains to associate with the added identity provider.",
);

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
  domains: legacySsoAddDomainsFlag,
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
  nameIdFormat: Flag.choice("name-id-format", LEGACY_SSO_NAME_ID_FORMATS).pipe(
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
      withLegacyCommandInstrumentation({
        flags,
        safeFlags: ["project-ref"],
        config,
        // `--type` registers `-t` (Flag.withAlias above); without this, `-t saml`
        // never resolves to the canonical `type` name in extractChangedFlagNames,
        // so it wouldn't appear in telemetry at all (Go's pflag.Visit reports the
        // canonical name regardless of shorthand — cmd/root_analytics.go:53-76).
        aliases: { t: "type" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["sso", "add"])),
);
