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
import { resolveLinkedParentRef } from "../parent-project-ref.ts";
import { findBranch, listParentBranches, resolveRemoteBranchRef } from "./branch-resolution.ts";
import type { RemoteValue } from "./remote-value.ts";
import type { LinkedTarget } from "./resolve-target.ts";
import { deprecationMessages, remoteFlagText } from "./target-deprecation.ts";
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

/** Prints one warning per deprecated selector flag the run used, rebuilt from the real command line when it is known. */
export const warnTargetDeprecations = Effect.fnUntraced(function* (
  deprecations: ReadonlyArray<TargetDeprecation>,
) {
  if (deprecations.length === 0) return;
  const { projectHost } = yield* CommandSettings;
  const argv = Option.getOrUndefined(
    Option.map(yield* Effect.serviceOption(CliArgs), (cli) => cli.args),
  );
  for (const message of deprecationMessages(deprecations, { argv, projectHost })) {
    yield* warnTarget(message);
  }
});

/**
 * Parses the selector flags, prints the deprecation warnings, and names the command for the
 * errors that need it.
 */
export const selectTarget = Effect.fnUntraced(function* (flags: TargetSelectorInput) {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const commandName = Option.isSome(runtime)
    ? `\`supabase ${getCommandRuntimeCommand(runtime.value)}\``
    : "This command";
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(flags, { commandName }),
    { onFailure: Effect.fail, onSuccess: Effect.succeed },
  );
  yield* warnTargetDeprecations(deprecations);
  return { selection, commandName };
});

const checkRemoteOperand = Effect.fn("Target.checkRemoteOperand")(function* (operand: string) {
  const parent = yield* resolveLinkedParentRef();
  if (parent.kind !== "resolved") return;

  const hint = `Did you mean ${remoteFlagText({ _tag: "Branch", name: operand })}?`;
  const branches = yield* listParentBranches(parent.ref, "Checking branches...").pipe(
    Effect.option,
  );
  if (Option.isNone(branches)) {
    return yield* new TargetRemoteAmbiguousError({
      message: `Could not list the branches of project ${parent.ref} to tell whether ${operand} names one. ${hint}`,
    });
  }
  if (findBranch(branches.value, operand) !== undefined) {
    return yield* new TargetRemoteAmbiguousError({
      message: `${operand} is a branch of project ${parent.ref}. ${hint}`,
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
    yield* cell.value.announce(
      renderBranchTarget({
        branch: Option.fromNullishOr(found.branchName),
        ref: found.projectRef,
        parentRef: Option.fromNullishOr(found.parentRef),
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
