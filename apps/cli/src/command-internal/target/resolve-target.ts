import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN, type ProjectRefSource } from "../../config/project-ref.service.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { readLinkSnapshotSoft } from "../../shared/config/link-snapshot.ts";
import { resolveHostedRemote, selectTarget } from "./remote-resolution.ts";
import type { TargetFlagValues } from "./target-flags.ts";
import { linkedAlternativeHint } from "./target-identity.ts";
import { TargetPolicy } from "./target-policy.ts";
import { TargetSelectorConflictError } from "./target.errors.ts";
import { passedStackSelectorFlag, rejectStackSelectorOnLegacy } from "../stack-target.ts";

export type ResolvedTarget =
  | { readonly kind: "local" }
  | {
      readonly kind: "linked";
      readonly ref: string;
      readonly source: ProjectRefSource;
      readonly matchesLinkedRef: boolean;
      /** The branch name or UUID `--remote` was given, when it named one. */
      readonly branch?: string | undefined;
      /** The linked project the branch was found under, when it was looked up through one. */
      readonly parentRef?: string | undefined;
      /** Whether the branch is the production branch, when its lookup said so. */
      readonly isDefault?: boolean | undefined;
      /** The IPv4 pooler URL the link recorded, present only when `ref` is the linked ref. */
      readonly poolerUrl?: string | undefined;
    }
  | { readonly kind: "db-url"; readonly url: Redacted.Redacted<string> };

export type LinkedTarget = Extract<ResolvedTarget, { readonly kind: "linked" }>;

type SelectedBy = "flag" | "default";

const hintLinkedAlternative = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { workdir, projectId } = yield* CommandSettings;
  const link = yield* readLinkSnapshotSoft(fs, path, workdir);
  const linkedRef = Option.filter(
    Option.orElse(projectId, () => link.ref),
    (ref) => PROJECT_REF_PATTERN.test(ref),
  );
  if (Option.isNone(linkedRef)) return;
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isNone(cell)) return;
  yield* cell.value.hintLocal(linkedAlternativeHint({ ref: linkedRef.value, cache: link.parent }));
});

/** The selector that picked a remote target, named the way the user typed it. */
const remoteFlagOf = (flags: TargetFlagValues): string =>
  flags.linked
    ? "--linked"
    : Option.isSome(flags.dbUrl ?? Option.none())
      ? "--db-url"
      : Option.isSome(flags.projectRef)
        ? "--project-ref"
        : Option.isSome(flags.projectId ?? Option.none())
          ? "--project-id"
          : "--remote";

/** `--stack`/`--stack-id` name a local stack, so a remote selector beside them is a conflict. */
const rejectRemoteStackSelector = Effect.fnUntraced(function* (flags: TargetFlagValues) {
  const flag = yield* passedStackSelectorFlag;
  if (flag === undefined) return;
  const remote = remoteFlagOf(flags);
  return yield* new TargetSelectorConflictError({
    flags: [flag, remote],
    message: `${flag} selects a local stack and cannot be combined with ${remote}.`,
    suggestion: `Drop ${flag} to target the remote database, or drop ${remote} to target the local stack.`,
  });
});

/**
 * Resolves the target a `selectable` command acts on: `--remote` (or a deprecated alias) picks a
 * linked project, a branch or a database URL, and no selector means the local stack.
 */
export const resolveTarget = Effect.fn("Target.resolve")(function* (flags: TargetFlagValues) {
  const policy = yield* TargetPolicy;
  if (policy.group !== "selectable") {
    return yield* Effect.die(
      new Error(`resolveTarget needs a selectable command, not "${policy.group}"`),
    );
  }
  const { selection } = yield* selectTarget(flags);
  yield* rejectStackSelectorOnLegacy;

  const finish = Effect.fnUntraced(function* (target: ResolvedTarget, selectedBy: SelectedBy) {
    yield* Effect.annotateCurrentSpan({
      "target.kind": target.kind,
      "target.selection": selectedBy,
    });
    return target;
  });

  switch (selection._tag) {
    case "Local":
      return yield* finish({ kind: "local" }, "flag");
    case "DbUrl":
      yield* rejectRemoteStackSelector(flags);
      return yield* finish({ kind: "db-url", url: Redacted.make(selection.url) }, "flag");
    case "Default":
      yield* hintLinkedAlternative();
      return yield* finish({ kind: "local" }, "default");
    case "Linked":
    case "Ref":
    case "Branch":
      yield* rejectRemoteStackSelector(flags);
      return yield* finish(yield* resolveHostedRemote(selection), "flag");
  }
});
