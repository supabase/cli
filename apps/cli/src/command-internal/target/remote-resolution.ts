import { Effect, FileSystem, Option, Path, Result } from "effect";

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
import { findBranch, listParentBranches, resolveRemoteBranchRef } from "./branch-resolution.ts";
import { LinkBranchListStatusError } from "./branch-resolution.errors.ts";
import { closestByName } from "./closest-branch.ts";
import type { RemoteValue } from "./remote-value.ts";
import { stripUserinfo } from "./remote-vocabulary.ts";
import type { LinkedTarget } from "./resolve-target.ts";
import {
  type DeprecationCommand,
  deprecationMessages,
  remoteFlagText,
  shellQuote,
} from "./target-deprecation.ts";
import { renderBranchTarget } from "./target-identity.ts";
import {
  parseTargetSelector,
  type TargetDeprecation,
  type TargetSelectorInput,
} from "./target-selector.ts";
import { TargetRemoteAmbiguousError } from "./target.errors.ts";

/** A `--remote` value that names a hosted project, as opposed to a database URL. */
export type HostedRemote = Exclude<RemoteValue, { readonly _tag: "DbUrl" }>;

/** Prints a target warning on stderr in every output format, since stdout may carry the payload. */
export const warnTarget = Effect.fnUntraced(function* (message: string) {
  const output = yield* Output;
  yield* output.raw(`${yellow(`Warning: ${message}`)}\n`, "stderr");
});

const currentCommand = Effect.fnUntraced(function* () {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  if (Option.isNone(runtime)) return undefined;
  const cliArgs = Option.getOrUndefined(yield* Effect.serviceOption(CliArgs));
  return {
    path: getCommandRuntimeCommand(runtime.value),
    operands: cliArgs?.operandPlaceholders?.() ?? [],
  } satisfies DeprecationCommand;
});

/** Prints one warning per deprecated selector flag the run used, naming the command, its operand placeholders and the `--remote` replacement. */
export const warnTargetDeprecations = Effect.fnUntraced(function* (
  deprecations: ReadonlyArray<TargetDeprecation>,
) {
  if (deprecations.length === 0) return;
  const { projectHost } = yield* CommandSettings;
  const command = yield* currentCommand();
  for (const message of deprecationMessages(deprecations, { command, projectHost })) {
    yield* warnTarget(message);
  }
});

/**
 * Parses the selector flags, prints the deprecation warnings, and names the command for the
 * errors that need it.
 */
export const selectTarget = Effect.fnUntraced(function* (
  flags: TargetSelectorInput,
  options: { readonly valueHint?: string } = {},
) {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const commandName = Option.isSome(runtime)
    ? `\`supabase ${getCommandRuntimeCommand(runtime.value)}\``
    : "This command";
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(flags, { commandName, ...options }),
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

const listingFailure = (error: unknown) => {
  const status = error instanceof LinkBranchListStatusError ? error.status : undefined;
  return {
    status,
    reason: status === undefined ? "" : ` with HTTP ${status}`,
    suggestion: status === 401 || status === 403 ? LOGIN_SUGGESTION : undefined,
  };
};

const checkRemoteOperand = Effect.fn("Target.checkRemoteOperand")(function* (rawOperand: string) {
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind !== "resolved") return;

  const operand = stripUserinfo(rawOperand);
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const usage = `supabase ${Option.isSome(runtime) ? getCommandRuntimeCommand(runtime.value) : "<command>"}`;
  const options = `For the branch: ${usage} ${remoteFlagText({ _tag: "Branch", name: operand })}. For the linked project: ${usage} ${shellQuote(operand)} --remote`;

  const listed = yield* listParentBranches(parent.ref, "Checking branches...").pipe(Effect.result);
  if (Result.isFailure(listed)) {
    const { status, reason, suggestion } = listingFailure(listed.failure);
    return yield* new TargetRemoteAmbiguousError({
      message: `Can't tell whether "${operand}" is a branch (listing the branches of project ${parent.ref} failed${reason}). ${options}`,
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(status === undefined ? {} : { status }),
      cause: listed.failure,
    });
  }
  const branches = listed.success;
  if (findBranch(branches, operand) !== undefined) {
    const name = yield* linkedProjectName(parent.ref);
    const project = name === undefined ? `project ${parent.ref}` : formatNamedRef(name, parent.ref);
    return yield* new TargetRemoteAmbiguousError({
      message: `"${operand}" is a branch of ${project}. ${options}`,
    });
  }
  const closest = closestByName(branches, operand);
  if (closest !== undefined) {
    const closestName = sanitizeInlineName(closest.name);
    return yield* new TargetRemoteAmbiguousError({
      message: `"${operand}" isn't a branch, but "${closestName}" is. For the branch: ${usage} ${remoteFlagText({ _tag: "Branch", name: closestName })}. For the linked project: ${usage} ${shellQuote(operand)} --remote`,
    });
  }
});

/**
 * Fails a bare `--remote` whose next word is, or may be, a branch of the linked project, before
 * the command prompts, connects or writes.
 */
const rejectAmbiguousRemote = Effect.fnUntraced(function* () {
  const cliArgs = yield* Effect.serviceOption(CliArgs);
  const operand = Option.getOrUndefined(cliArgs)?.bareRemoteOperand;
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
