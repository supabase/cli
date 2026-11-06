import { SupabaseApiConfigError, SupabaseApiInputError } from "@supabase/api/effect";
import { CliConfigFileConflictError, CliConfigRemovedKeyError } from "@supabase/config";
import { Config, Schema } from "effect";
import { Argument, Flag } from "effect/cli";
import { HttpBody } from "effect/http";
import { PlatformError } from "effect/PlatformError";

import { AccessTokenRequiredError, InvalidAccessTokenError } from "../../../auth/errors.ts";
import { defineContract } from "../../../command-internal/command-contract/command-contract.annotation.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { InvalidOutputFormatError } from "../../../command-internal/output-formats.ts";
import { ProfileLoadError } from "../../../command-internal/profile-load.ts";
import { RemovedSurfaceError } from "../../../command-internal/removed-command.ts";
import {
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkBranchNotReadyError,
  LinkParentRefInvalidError,
} from "../../../command-internal/target/branch-resolution.errors.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import {
  TargetEmptyValueError,
  TargetInvalidValueError,
  TargetProjectRefConflictError,
  TargetRemoteAmbiguousError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import {
  CliConfigFlagConflictError,
  CliConfigRemovedEnvError,
  CliConfigValueError,
} from "../../../config/cli-config.errors.ts";
import { ApiMaxRetriesError } from "../../../config/command-settings.layer.ts";
import {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
} from "../../../config/project-ref.errors.ts";
import { ExperimentalFeatureFlagError } from "../../../shared/config/experimental-feature.ts";
import { ProjectRefReadError } from "../../../shared/config/legacy-project-state.service.ts";
import {
  ProjectLinkIoError,
  ProjectLinkMalformedError,
} from "../../../shared/config/project-link.ts";
import {
  InvalidSecretPairError,
  SecretsEnvFileOpenError,
  SecretsEnvFileParseError,
  SecretsNoArgumentsError,
  SecretsSetInputError,
  SecretsSetNetworkError,
  SecretsSetUnexpectedStatusError,
} from "../secrets.errors.ts";

const SecretsSetResult = Schema.Struct({ project_ref: Schema.String, count: Schema.Int });

export const secretsSetContract = defineContract({
  input: {
    ...projectTargetFlags(),
    envFile: Flag.String("env-file").pipe(
      Flag.withDescription("Read secrets from a .env file."),
      Flag.optional,
    ),
    secrets: Argument.String("NAME=VALUE").pipe(
      Argument.withDescription("Secret name=value pairs to set."),
      Argument.variadic(),
    ),
  },
  globalFlags: [DebugFlag, DnsResolverFlag, OutputFlag, ProfileFlag, WorkdirFlag, YesFlag],
  configuration: {
    configKeys: [],
    settings: ["accessToken", "profile", "apiMaxRetries", "projectId", "workdir", "supabaseHome"],
  },
  output: {
    data: SecretsSetResult,
    text: { stream: "stdout", example: "Finished supabase secrets set." },
  },
  errors: [
    {
      error: SecretsSetNetworkError,
      when: "A bulk-create request fails before a response arrives.",
      nextStep: "Check your network connection and run the command again.",
    },
    {
      error: SecretsSetUnexpectedStatusError,
      when: "A bulk-create request returns a non-success status.",
    },
    {
      error: SecretsSetInputError,
      when: "A secret name or value fails the Management API client's schema.",
    },
    { error: InvalidSecretPairError, when: "A positional argument isn't NAME=VALUE." },
    {
      error: SecretsNoArgumentsError,
      when: "No secrets remain after merging config, --env-file and arguments.",
    },
    { error: SecretsEnvFileOpenError, when: "The --env-file path can't be read." },
    { error: SecretsEnvFileParseError, when: "The --env-file contents can't be parsed." },
    {
      error: HostedMutationConsentRequiredError,
      when: "The run can't prompt and neither --yes nor a shell SUPABASE_YES is set.",
    },
    { error: HostedMutationDeclinedError, when: "The confirmation prompt was declined." },
    {
      error: CliConfigValueError,
      when: "A config value from a flag or the environment fails its codec.",
    },
    {
      error: CliConfigFlagConflictError,
      when: "Two flags bound to the same config key disagree.",
    },
    { error: CliConfigRemovedEnvError, when: "A removed config environment variable is set." },
    { error: CliConfigRemovedKeyError, when: "The config file uses a removed key." },
    {
      error: CliConfigFileConflictError,
      when: "More than one config file is present in the workdir.",
    },
    {
      error: ProjectRefNotLinkedError,
      when: "No project ref comes from --remote, SUPABASE_PROJECT_ID or the linked project.",
      nextStep: "Run `supabase link` or pass --remote=<ref>.",
    },
    {
      error: InvalidProjectRefError,
      when: "The project ref isn't a valid project ref.",
      nextStep: "Pass a 20-letter project ref with --remote.",
    },
    {
      error: TargetRemoteAmbiguousError,
      when: "A bare --remote is followed by a word that could be a value or a NAME=VALUE pair.",
      nextStep: "Write --remote=<ref>.",
    },
    {
      error: TargetSelectorConflictError,
      when: "More than one project selector flag was given.",
      nextStep: "Pass only --remote.",
    },
    {
      error: TargetProjectRefConflictError,
      when: "The deprecated selector flags disagree about the project ref.",
      nextStep: "Pass only --remote.",
    },
    {
      error: TargetEmptyValueError,
      when: "A project selector flag was given an empty value.",
      nextStep: "Pass a project ref, or omit the flag.",
    },
    {
      error: TargetInvalidValueError,
      when: "A deprecated project selector flag was given a value that isn't a project ref.",
      nextStep: "Pass a 20-letter project ref with --remote.",
    },
    { error: LinkBranchNotLinkedError, when: "The linked branch has no parent project." },
    { error: LinkParentRefInvalidError, when: "The linked parent project ref is invalid." },
    { error: LinkBranchNotFoundError, when: "The linked branch no longer exists." },
    { error: LinkBranchNotReadyError, when: "The linked branch isn't ready yet." },
    {
      error: LinkBranchListNetworkError,
      when: "Listing branches to resolve the linked branch fails before a response arrives.",
    },
    {
      error: LinkBranchListStatusError,
      when: "Listing branches to resolve the linked branch returns a non-200 status.",
    },
    {
      error: ProjectRefReadError,
      when: "`supabase/.temp/project-ref` exists but can't be read.",
      nextStep: "Check the file's permissions, or run `supabase link` again.",
    },
    {
      error: ProjectLinkMalformedError,
      when: "The linked project file can't be parsed.",
      nextStep: "Run `supabase link` again.",
    },
    {
      error: ProjectLinkIoError,
      when: "The linked project file can't be read.",
      nextStep: "Check the file's permissions, or run `supabase link` again.",
    },
    {
      error: ExperimentalFeatureFlagError,
      when: "An experimental project-state setting is invalid.",
      nextStep: "Unset the experimental flag or fix its value.",
    },
    {
      error: SupabaseApiInputError,
      when: "A request parameter fails the Management API client's schema.",
    },
    { error: HttpBody.HttpBodyError, when: "A request body can't be encoded." },
    { error: Config.ConfigError, when: "A CLI setting read from the environment is invalid." },
    { error: AccessTokenRequiredError, when: "No access token is set or stored." },
    { error: InvalidAccessTokenError, when: "The access token isn't in the expected format." },
    { error: SupabaseApiConfigError, when: "The Management API client settings are invalid." },
    { error: PlatformError, when: "A local file under `supabase/.temp` can't be read or written." },
    { error: ProfileLoadError, when: "The selected profile can't be loaded." },
    {
      error: ApiMaxRetriesError,
      when: "SUPABASE_API_MAX_RETRIES isn't a non-negative integer.",
    },
    { error: InvalidOutputFormatError, when: "-o names a format this command doesn't support." },
    { error: RemovedSurfaceError, when: "A removed global flag was passed." },
  ],
  writes: [],
  presentation: {
    examples: [
      {
        command: "supabase secrets set MY_SECRET=myvalue",
        description: "Set a secret by name and value",
      },
      {
        command: "supabase secrets set --env-file .env",
        description: "Set secrets from a .env file",
      },
    ],
  },
});
