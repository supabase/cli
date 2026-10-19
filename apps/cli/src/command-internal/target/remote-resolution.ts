import { Effect, Option } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { yellow } from "../colors.ts";
import { resolveLinkedParentRef } from "../parent-project-ref.ts";
import {
  findBranch,
  listParentBranches,
  resolveLinkBranchRef,
  type BranchResolution,
} from "./branch-resolution.ts";
import { couldNameBranch, type RemoteValue } from "./remote-value.ts";
import { deprecationMessages, remoteFlagText } from "./target-deprecation.ts";
import { renderBranchTarget } from "./target-identity.ts";
import type { TargetDeprecation } from "./target-selector.ts";
import { TargetRemoteAmbiguousError } from "./target.errors.ts";

/**
 * The word a bare `--remote` is directly followed by when it could name a branch. A bare
 * `--remote` ahead of an operand reaches the command as a flag plus a positional, so the word may
 * be meant as `--remote=<word>`.
 */
const bareRemoteOperand = (argv: ReadonlyArray<string>): string | undefined => {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  const index = flags.indexOf("--remote");
  const next = index === -1 ? undefined : flags[index + 1];
  if (next === undefined || next.startsWith("-")) return undefined;
  return couldNameBranch(next) ? next : undefined;
};

/** Prints one warning per deprecated selector flag the run used on stderr in every output format, rebuilt from the real command line when it is known. */
export const warnTargetDeprecations = Effect.fnUntraced(function* (
  deprecations: ReadonlyArray<TargetDeprecation>,
) {
  if (deprecations.length === 0) return;
  const output = yield* Output;
  const { projectHost } = yield* CommandSettings;
  const argv = Option.getOrUndefined(
    Option.map(yield* Effect.serviceOption(CliArgs), (cli) => cli.args),
  );
  for (const message of deprecationMessages(deprecations, { argv, projectHost })) {
    yield* output.raw(`${yellow(`Warning: ${message}`)}\n`, "stderr");
  }
});

/**
 * Fails a bare `--remote` whose next word is, or may be, a branch of the linked project, before
 * the command prompts, connects or writes.
 */
export const rejectAmbiguousRemote = Effect.fn("Target.checkRemoteOperand")(function* (
  remote: Option.Option<RemoteValue>,
) {
  if (!Option.exists(remote, (value) => value._tag === "Linked")) return;
  const cliArgs = yield* Effect.serviceOption(CliArgs);
  const operand = Option.isSome(cliArgs) ? bareRemoteOperand(cliArgs.value.args) : undefined;
  if (operand === undefined) return;
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

/** Resolves a branch name or UUID to its project ref and announces it as the run's target. */
export const resolveRemoteBranch = Effect.fnUntraced(function* (name: string) {
  const found: BranchResolution = yield* resolveLinkBranchRef(name);
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isSome(cell)) {
    yield* cell.value.announce(
      renderBranchTarget({
        branch: Option.some(found.branchName),
        ref: found.projectRef,
        parentRef: Option.some(found.parentRef),
      }),
    );
  }
  return found;
});
