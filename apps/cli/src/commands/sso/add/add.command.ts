import { Command, Flag } from "effect/cli";
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
import { ssoAdd } from "./add.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

// `--domains` is a CSV string-slice flag; malformed CSV reports a diagnostic (see `stringSliceFlag`).
export const ssoAddDomainsFlag = stringSliceFlag(
  "domains",
  "Email domains to associate with the identity provider, comma-separated or repeated.",
);

const config = {
  ...projectTargetFlags(),
  // No `Flag.optional`: `--type` is required, enforced by the CLI parser.
  type: cliFlag("type", (name) => Flag.Literals(name, ["saml"] as const), {
    description: "Type of identity provider, based on its protocol.",
    alias: "t",
    required: true,
  }),
  domains: ssoAddDomainsFlag,
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
};
export type SsoAddFlags = CliCommand.Command.Config.Infer<typeof config>;

export const ssoAddCommand = makeCommand("add", config).pipe(
  Command.withDescription(
    "Connects a SAML 2.0 identity provider to your project. Provide its metadata with `--metadata-url` or `--metadata-file`.",
  ),
  Command.withShortDescription("Add a new SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso add --type saml --metadata-url 'https://...' --domains example.com --remote=mwjylndxudmiehsxhmmz",
      description: "Add a new SAML SSO provider",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-create-a-sso-provider", kind: "required" }],
        noApiEffectFlags: [
          "type",
          "domains",
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
    ssoAdd(flags).pipe(
      withCommandTelemetry({
        flags,
        config,
        // Maps the `-t` alias back to `type` so telemetry records it as changed.
        aliases: { t: "type" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["sso", "add"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
