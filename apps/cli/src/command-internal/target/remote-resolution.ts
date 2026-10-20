import { Effect, FileSystem, Option, Path, Result } from "effect";

import { AccessTokenRequiredError, InvalidAccessTokenError } from "../../auth/errors.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver, type ResolvedProjectRef } from "../../config/project-ref.service.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { readProjectRefFile } from "../../shared/config/temp-paths.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import { yellow } from "../colors.ts";
import { formatNamedRef, sanitizeInlineName } from "../http-errors.ts";
import { readCachedLinkedProject, resolveLinkedParentRef } from "../parent-project-ref.ts";
import { BRANCH_PROJECT_REF_PATTERN } from "../ref-patterns.ts";
import {
  findBranch,
  isDefaultBranch,
  listBranchesFailureCause,
  listLinkedParentBranches,
  previewBranchHint,
  resolveRemoteBranchRef,
} from "./branch-resolution.ts";
import {
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
} from "./branch-resolution.errors.ts";
import { nearMissByName } from "./closest-branch.ts";
import type { RemoteValue } from "./remote-value.ts";
import { stripUserinfo } from "./remote-vocabulary.ts";
import type { LinkedTarget } from "./resolve-target.ts";
import { deprecationMessages, remoteFlagText, shellQuote } from "./target-deprecation.ts";
import type { TargetFlagValues } from "./target-flags.ts";
import { describeLinkedTarget, renderBranchTarget } from "./target-identity.ts";
import { parseTargetSelector, type TargetDeprecation } from "./target-selector.ts";
import { TargetRemoteAmbiguousError } from "./target.errors.ts";

/** A `--remote` value that names a hosted project, as opposed to a database URL. */
export type HostedRemote = Exclude<RemoteValue, { readonly _tag: "DbUrl" }>;

/** Prints a target warning on stderr in every output format, since stdout may carry the payload. */
export const warnTarget = Effect.fnUntraced(function* (message: string) {
  const output = yield* Output;
  yield* output.raw(`${yellow(`Warning: ${message}`)}\n`, "stderr");
});

/** Prints one warning per deprecated selector flag the run used, naming its `--remote` replacement. */
export const warnTargetDeprecations = Effect.fnUntraced(function* (
  deprecations: ReadonlyArray<TargetDeprecation>,
) {
  if (deprecations.length === 0) return;
  const { projectHost } = yield* CommandSettings;
  for (const message of deprecationMessages(deprecations, projectHost)) {
    yield* warnTarget(message);
  }
});

/**
 * Parses the selector flags, prints the deprecation warnings, and names the command for the
 * errors that need it.
 */
export const selectTarget = Effect.fnUntraced(function* (
  flags: TargetFlagValues,
  options: { readonly valueHint?: string } = {},
) {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const commandName = Option.isSome(runtime)
    ? `\`supabase ${getCommandRuntimeCommand(runtime.value)}\``
    : "This command";
  const cliArgs = yield* Effect.serviceOption(CliArgs);
  const remoteConflict = Option.getOrUndefined(cliArgs)?.remoteConflict === true;
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(flags, { remoteConflict, ...options }),
    { onFailure: Effect.fail, onSuccess: Effect.succeed },
  );
  yield* warnTargetDeprecations(deprecations);
  return { selection, commandName };
});

const linkedProjectName = Effect.fnUntraced(function* (ref: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { workdir } = yield* CommandSettings;
  const cache = Option.getOrUndefined(yield* readCachedLinkedProject(fs, path, workdir));
  return cache?.ref === ref ? cache.name : undefined;
});

const LOGIN_SUGGESTION =
  "Run `supabase login` with an account that can list this project's branches.";
const SET_TOKEN_SUGGESTION = "Set SUPABASE_ACCESS_TOKEN to a valid access token.";
const FORBIDDEN_SUGGESTION = "Use an access token that can read this project's branches.";

type TokenSource = "env" | "stored";

interface ListingFailure {
  readonly reason: string;
  readonly suggestion?: string | undefined;
  readonly status?: number;
  readonly authFailure?: "login" | "token";
}

const statusFailure = (
  status: number,
  parentRef: string,
  tokenSource: TokenSource,
): ListingFailure => {
  const reason = `: HTTP ${status}`;
  switch (status) {
    case 401:
      return tokenSource === "env"
        ? { status, reason, suggestion: SET_TOKEN_SUGGESTION, authFailure: "token" }
        : { status, reason, suggestion: LOGIN_SUGGESTION };
    case 403:
      return { status, reason, suggestion: FORBIDDEN_SUGGESTION };
    case 404:
      return { status, reason, suggestion: previewBranchHint(parentRef) };
    default:
      return { status, reason };
  }
};

const listingFailure = (
  error: unknown,
  parentRef: string,
  tokenSource: TokenSource,
): ListingFailure => {
  if (error instanceof LinkBranchListStatusError) {
    return statusFailure(error.status, parentRef, tokenSource);
  }
  if (error instanceof LinkBranchListNetworkError) {
    return { reason: `: ${sanitizeInlineName(stripUserinfo(listBranchesFailureCause(error)))}` };
  }
  if (error instanceof AccessTokenRequiredError) {
    return {
      reason: " because no access token is set",
      suggestion: LOGIN_SUGGESTION,
      authFailure: "login",
    };
  }
  if (error instanceof InvalidAccessTokenError) {
    return error.source === "env"
      ? {
          reason: " because SUPABASE_ACCESS_TOKEN is not a valid access token",
          suggestion: SET_TOKEN_SUGGESTION,
          authFailure: "token",
        }
      : {
          reason: " because the stored access token is not valid",
          suggestion: LOGIN_SUGGESTION,
          authFailure: "login",
        };
  }
  return { reason: "" };
};

const commandUsage = Effect.fnUntraced(function* () {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  return `supabase ${Option.isSome(runtime) ? getCommandRuntimeCommand(runtime.value) : "<command>"}`;
});

const checkRemoteOperand = Effect.fn("Target.checkRemoteOperand")(function* (rawOperand: string) {
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind !== "resolved") return;

  const operand = stripUserinfo(rawOperand);
  const usage = yield* commandUsage();
  const options = `For the branch: ${usage} ${remoteFlagText({ _tag: "Branch", name: operand })}. For the linked project: ${usage} ${shellQuote(operand)} --remote`;

  const listed = yield* listLinkedParentBranches(parent, "Checking branches...").pipe(
    Effect.result,
  );
  if (Result.isFailure(listed)) {
    const { accessToken } = yield* CommandSettings;
    const failure = listingFailure(
      listed.failure,
      parent.ref,
      Option.isSome(accessToken) ? "env" : "stored",
    );
    return yield* new TargetRemoteAmbiguousError({
      message: `Can't tell whether the word after --remote is a branch (listing the branches of project ${parent.ref} failed${failure.reason}). For the branch: ${usage} --remote=<branch>. For the linked project, put --remote last: ${usage} <operands> --remote`,
      ...(failure.suggestion === undefined ? {} : { suggestion: failure.suggestion }),
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.authFailure === undefined ? {} : { authFailure: failure.authFailure }),
      cause: listed.failure,
    });
  }
  const { parentRef, branches } = listed.success;
  if (findBranch(branches, operand) !== undefined) {
    const name = yield* linkedProjectName(parentRef);
    const project = name === undefined ? `project ${parentRef}` : formatNamedRef(name, parentRef);
    return yield* new TargetRemoteAmbiguousError({
      message: `"${operand}" is a branch of ${project}. ${options}`,
    });
  }
  const closest = nearMissByName(branches, operand, (branch) => isDefaultBranch(branch, parentRef));
  if (closest !== undefined) {
    const closestName = sanitizeInlineName(closest.name);
    return yield* new TargetRemoteAmbiguousError({
      message: `"${operand}" isn't a branch, but "${closestName}" is. For the branch: ${usage} ${remoteFlagText({ _tag: "Branch", name: closestName })}. For the linked project: ${usage} ${shellQuote(operand)} --remote`,
    });
  }
});

const rejectRefShapedOperand = Effect.fnUntraced(function* (operand: string) {
  const usage = yield* commandUsage();
  return yield* new TargetRemoteAmbiguousError({
    message: `"${operand}" after --remote looks like a project ref. For that project: ${usage} --remote=${operand}. To keep it as an operand, put --remote last: ${usage} <operands> --remote`,
  });
});

const bareRemoteWord = Effect.fnUntraced(function* () {
  const cliArgs = yield* Effect.serviceOption(CliArgs);
  return Option.getOrUndefined(cliArgs)?.bareRemoteOperand;
});

/** Fails a bare `--remote` whose next word is a project ref, before the command prompts, connects or writes. */
export const rejectRefShapedRemote = Effect.fnUntraced(function* () {
  const operand = yield* bareRemoteWord();
  if (operand !== undefined && BRANCH_PROJECT_REF_PATTERN.test(operand)) {
    return yield* rejectRefShapedOperand(operand);
  }
});

/**
 * Fails a bare `--remote` whose next word is a project ref, or is, or may be, a branch of the
 * linked project, before the command prompts, connects or writes.
 */
const rejectAmbiguousRemote = Effect.fnUntraced(function* () {
  yield* rejectRefShapedRemote();
  const operand = yield* bareRemoteWord();
  if (operand !== undefined) yield* checkRemoteOperand(operand);
});

/** The linked target for a ref the ref chain has already resolved and announced. */
const linkedTarget = (resolved: ResolvedProjectRef): LinkedTarget => ({
  kind: "linked",
  ref: resolved.ref,
  source: resolved.source,
  matchesLinkedRef: resolved.matchesLinkedRef,
});

const resolveRemoteBranch = Effect.fnUntraced(function* (name: string) {
  const found = yield* resolveRemoteBranchRef(name);
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isSome(cell)) {
    if (found.isDefault === undefined) {
      yield* cell.value.announce(
        describeLinkedTarget({ ref: found.projectRef, cache: Option.none() }),
      );
      return found;
    }
    const nameOwner = found.isDefault ? found.projectRef : found.parentRef;
    yield* cell.value.announce(
      renderBranchTarget({
        branch: Option.fromNullishOr(found.branchName),
        ref: found.projectRef,
        parentRef: Option.fromNullishOr(found.parentRef),
        parentName: nameOwner === undefined ? undefined : yield* linkedProjectName(nameOwner),
        isDefault: found.isDefault,
      }),
    );
  }
  return found;
});

/** The linked target for one hosted `--remote` value; announces it, as a branch when the value names one. */
export const resolveRemoteTarget = Effect.fn("Target.resolveRemote")(function* (
  remote: HostedRemote,
) {
  if (remote._tag === "Branch") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { workdir } = yield* CommandSettings;
    const found = yield* resolveRemoteBranch(remote.name);
    const linkedRef = yield* readProjectRefFile(fs, path, workdir).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return {
      ...linkedTarget({
        ref: found.projectRef,
        source: "flag",
        matchesLinkedRef: Option.contains(linkedRef, found.projectRef),
      }),
      branch: remote.name,
      ...(found.parentRef === undefined ? {} : { parentRef: found.parentRef }),
      ...(found.isDefault === undefined ? {} : { isDefault: found.isDefault }),
    } satisfies LinkedTarget;
  }
  const projectRef = yield* ProjectRefResolver;
  return linkedTarget(
    yield* projectRef.resolveRef(remote._tag === "Ref" ? Option.some(remote.ref) : Option.none()),
  );
});

/**
 * Resolves a hosted selection to its project: a bare `--remote` first checks that the word after
 * it does not name a branch, then the value's own lookup runs.
 */
export const resolveHostedRemote = Effect.fnUntraced(function* (remote: HostedRemote) {
  if (remote._tag === "Linked") yield* rejectAmbiguousRemote();
  return yield* resolveRemoteTarget(remote);
});
