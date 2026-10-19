import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { PROJECT_REF_PATTERN, type ProjectRefSource } from "../../config/project-ref.service.ts";
import { readProjectRefFile } from "../../shared/config/temp-paths.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { readCachedLinkedProject } from "../parent-project-ref.ts";
import { resolveHostedRemote, selectTarget } from "./remote-resolution.ts";
import type { TargetFlagValuesWithDbUrl, TargetFlagValuesWithoutDbUrl } from "./target-flags.ts";
import { linkedAlternativeHint } from "./target-identity.ts";
import { TargetPolicy } from "./target-policy.ts";
import type { TargetSelectorInput } from "./target-selector.ts";

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
    }
  | { readonly kind: "db-url"; readonly url: Redacted.Redacted<string> };

export type LinkedTarget = Extract<ResolvedTarget, { readonly kind: "linked" }>;

type SelectedBy = "flag" | "default";

const hintLinkedAlternative = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { workdir } = yield* CommandSettings;
  const linkedRef = yield* readProjectRefFile(fs, path, workdir).pipe(
    Effect.map(Option.filter((ref) => PROJECT_REF_PATTERN.test(ref))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(linkedRef)) return;
  const cell = yield* Effect.serviceOption(CommandTarget);
  if (Option.isNone(cell)) return;
  const cache = yield* readCachedLinkedProject(fs, path, workdir);
  yield* cell.value.hintLocal(linkedAlternativeHint({ ref: linkedRef.value, cache }));
});

const resolveSelected = Effect.fn("Target.resolve")(function* (flags: TargetSelectorInput) {
  const policy = yield* TargetPolicy;
  if (policy.group !== "selectable") {
    return yield* Effect.die(
      new Error(`resolveTarget needs a selectable command, not "${policy.group}"`),
    );
  }
  const { selection } = yield* selectTarget(flags);

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
      return yield* finish({ kind: "db-url", url: Redacted.make(selection.url) }, "flag");
    case "Default":
      yield* hintLinkedAlternative();
      return yield* finish({ kind: "local" }, "default");
    case "Linked":
    case "Ref":
    case "Branch":
      return yield* finish(yield* resolveHostedRemote(selection), "flag");
  }
});

/**
 * Resolves the target a `selectable` command acts on: `--remote` (or a deprecated alias) picks a
 * linked project, a branch or a database URL, and no selector means the local stack. A command
 * whose flags came from `targetFlags({ dbUrl: false })` cannot pass a database URL here.
 */
export function resolveTarget(flags: TargetFlagValuesWithDbUrl): ReturnType<typeof resolveSelected>;
export function resolveTarget(
  flags: TargetFlagValuesWithoutDbUrl,
): ReturnType<typeof resolveSelected>;
export function resolveTarget(flags: TargetSelectorInput) {
  return resolveSelected(flags);
}
