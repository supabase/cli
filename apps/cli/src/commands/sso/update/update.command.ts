import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { upgradeSuggestion } from "../../../command-internal/upgrade-suggest.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { SSO_NAME_ID_FORMATS } from "../sso.saml.ts";
import { ssoUpdate } from "./update.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

// All three domain flags are CSV string-slice flags; malformed CSV reports
// a diagnostic (see `stringSliceFlag`).
export const ssoUpdateDomainsFlag = stringSliceFlag(
  "domains",
  "Email domains that replace the current list, comma-separated or repeated.",
);

export const ssoUpdateAddDomainsFlag = stringSliceFlag(
  "add-domains",
  "Email domains to add to the identity provider, comma-separated or repeated.",
);

export const ssoUpdateRemoveDomainsFlag = stringSliceFlag(
  "remove-domains",
  "Email domains to remove from the identity provider, comma-separated or repeated.",
);

const config = {
  ...projectTargetFlags(),
  domains: ssoUpdateDomainsFlag,
  addDomains: ssoUpdateAddDomainsFlag,
  removeDomains: ssoUpdateRemoveDomainsFlag,
  metadataFile: cliFlag("metadata-file", Flag.String, {
    description: "Path to a SAML 2.0 Metadata XML file describing the identity provider.",
    optional: true,
  }),
  metadataUrl: cliFlag("metadata-url", Flag.String, {
    description: "URL of a SAML 2.0 Metadata XML document describing the identity provider.",
    optional: true,
  }),
  skipUrlValidation: cliFlag("skip-url-validation", Flag.Boolean, {
    description:
      "Skip local validation of the metadata URL, such as in CI where the identity provider is unreachable.",
    default: false,
  }),
  attributeMappingFile: cliFlag("attribute-mapping-file", Flag.String, {
    description: "Path to a JSON file mapping SAML attributes to custom JWT claims.",
    optional: true,
  }),
  nameIdFormat: cliFlag("name-id-format", (name) => Flag.Literals(name, SSO_NAME_ID_FORMATS), {
    description: "SAML name ID format URI used to identify users.",
    optional: true,
  }),
  providerId: cliArgument("provider-id", Argument.String, {
    description: "The ID of the SSO identity provider to update.",
    required: true,
  }),
};
export type SsoUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoUpdateCommand = makeCommand("update", config).pipe(
  Command.withDescription(
    "Changes the email domains, metadata, attribute mapping or name ID format of a connected identity provider.",
  ),
  Command.withShortDescription("Update information about an SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --add-domains example.com --remote=mwjylndxudmiehsxhmmz",
      description: "Update an SSO provider's domains",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v1-get-a-sso-provider", kind: "required" },
          { operationId: "v1-update-a-sso-provider", kind: "required" },
        ],
        noApiEffectFlags: [
          "domains",
          "add-domains",
          "remove-domains",
          "metadata-file",
          "metadata-url",
          "skip-url-validation",
          "attribute-mapping-file",
          "name-id-format",
        ],
      },
      upgradeSuggestion,
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    ssoUpdate(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "update"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
