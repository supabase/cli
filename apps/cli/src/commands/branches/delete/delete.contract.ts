import { SupabaseApiConfigError, SupabaseApiInputError } from "@supabase/api/effect";
import { Config, Schema } from "effect";
import { Argument } from "effect/cli";
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
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { InvalidOutputFormatError } from "../../../command-internal/output-formats.ts";
import { ProfileLoadError } from "../../../command-internal/profile-load.ts";
import { RemovedSurfaceError } from "../../../command-internal/removed-command.ts";
import {
  TargetEmptyValueError,
  TargetInvalidValueError,
  TargetNeedsProjectError,
  TargetProjectRefConflictError,
  TargetRemoteAmbiguousError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
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
  BranchesBranchingDisabledError,
  BranchesBranchNameEmptyError,
  BranchesDeleteNetworkError,
  BranchesDeleteUnexpectedStatusError,
  BranchesFindNetworkError,
  BranchesFindUnexpectedStatusError,
  BranchesGetNetworkError,
  BranchesGetUnexpectedStatusError,
  BranchesListNetworkError,
  BranchesListUnexpectedStatusError,
} from "../branches.errors.ts";

const DeletedBranch = Schema.Struct({ project_ref: Schema.String });

export const branchesDeleteContract = defineContract({
  input: {
    name: Argument.String("name").pipe(
      Argument.withDescription("Branch name or ID to delete."),
      Argument.optional,
    ),
    ...projectTargetFlags({ parent: true }),
  },
  globalFlags: [DebugFlag, DnsResolverFlag, OutputFlag, ProfileFlag, WorkdirFlag, YesFlag],
  output: {
    data: DeletedBranch,
    text: { stream: "stderr", example: "Deleted preview branch: abcdefghijklmnopqrst" },
  },
  errors: [
    {
      error: BranchesDeleteNetworkError,
      when: "The delete request fails before a response arrives.",
      nextStep: "Check your network connection and run the command again.",
    },
    {
      error: BranchesDeleteUnexpectedStatusError,
      when: "The delete request returns a non-200 status.",
      nextStep: "Check the branch still exists with `supabase branches list`.",
    },
    {
      error: BranchesFindNetworkError,
      when: "Looking up a branch by name fails before a response arrives.",
      nextStep: "Check your network connection and run the command again.",
    },
    {
      error: BranchesFindUnexpectedStatusError,
      when: "Looking up a branch by name returns a non-200 status.",
      nextStep: "Check the branch name with `supabase branches list`.",
    },
    {
      error: BranchesGetNetworkError,
      when: "Looking up a branch by UUID fails before a response arrives.",
      nextStep: "Check your network connection and run the command again.",
    },
    {
      error: BranchesGetUnexpectedStatusError,
      when: "Looking up a branch by UUID returns a non-200 status.",
      nextStep: "Check the branch ID with `supabase branches list`.",
    },
    {
      error: BranchesListNetworkError,
      when: "Listing branches for the picker fails before a response arrives.",
      nextStep: "Check your network connection, or pass the branch name.",
    },
    {
      error: BranchesListUnexpectedStatusError,
      when: "Listing branches for the picker returns a non-200 status.",
      nextStep: "Pass the branch name as an argument.",
    },
    {
      error: BranchesBranchNameEmptyError,
      when: "No branch name was given and the prompt answer was empty.",
      nextStep: "Pass the branch name as an argument.",
    },
    { error: BranchesBranchingDisabledError, when: "The parent project has no branches." },
    {
      error: HostedMutationConsentRequiredError,
      when: "The run can't prompt and neither --yes nor a shell SUPABASE_YES is set.",
    },
    { error: HostedMutationDeclinedError, when: "The confirmation prompt was declined." },
    {
      error: ProjectRefNotLinkedError,
      when: "No parent project ref comes from --remote, SUPABASE_PROJECT_ID or the linked project.",
      nextStep: "Run `supabase link` or pass --remote=<ref>.",
    },
    {
      error: InvalidProjectRefError,
      when: "The parent project ref isn't a valid project ref.",
      nextStep: "Pass a 20-letter project ref with --remote.",
    },
    {
      error: TargetNeedsProjectError,
      when: "--remote names something other than a parent project ref.",
      nextStep: "Pass the parent's ref with --remote=<ref>.",
    },
    {
      error: TargetRemoteAmbiguousError,
      when: "A bare --remote is followed by a word that could be a value or the branch argument.",
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
      nextStep: "Check the branch name or ID.",
    },
    { error: HttpBody.HttpBodyError, when: "A request body can't be encoded." },
    { error: Config.ConfigError, when: "A CLI setting read from the environment is invalid." },
    { error: AccessTokenRequiredError, when: "No access token is set or stored." },
    { error: InvalidAccessTokenError, when: "The access token isn't in the expected format." },
    { error: ProfileLoadError, when: "The selected profile can't be loaded." },
    {
      error: ApiMaxRetriesError,
      when: "SUPABASE_API_MAX_RETRIES isn't a non-negative integer.",
    },
    { error: SupabaseApiConfigError, when: "The Management API client settings are invalid." },
    { error: InvalidOutputFormatError, when: "-o names a format this command doesn't support." },
    { error: RemovedSurfaceError, when: "A removed global flag was passed." },
    { error: PlatformError, when: "A local file under `supabase/.temp` can't be read or written." },
  ],
  writes: [
    {
      operationId: "v1-delete-a-branch",
      targetParam: "branch_id_or_ref",
      targets: [
        {
          from: "input",
          input: "name",
          when: "the argument or typed answer is a 20-letter project ref",
        },
        {
          from: "lookup",
          operationId: "v1-get-a-branch",
          field: "project_ref",
          when: "the argument or typed answer is a branch name",
        },
        {
          from: "lookup",
          operationId: "v1-get-a-branch-config",
          field: "ref",
          when: "the argument or typed answer is a UUID",
        },
      ],
      max: 1,
    },
  ],
  presentation: {
    examples: [
      {
        command: "supabase branches delete feature-login",
        description: "Delete a preview branch by name",
      },
      {
        command: "supabase branches delete feature-login --remote=abcdefghijklmnopqrst --yes",
        description: "Delete a branch of a given parent project without a prompt",
      },
    ],
  },
});
