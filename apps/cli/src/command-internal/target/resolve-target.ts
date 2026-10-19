import { Effect, FileSystem, Option, Path, Redacted, Result } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import {
  PROJECT_REF_PATTERN,
  ProjectRefResolver,
  type ProjectRefSource,
  type ResolvedProjectRef,
} from "../../config/project-ref.service.ts";
import { readProjectRefFile } from "../../shared/config/temp-paths.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { readCachedLinkedProject } from "../parent-project-ref.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import {
  rejectAmbiguousRemote,
  resolveRemoteBranch,
  warnTargetDeprecations,
} from "./remote-resolution.ts";
import type { RemoteValue } from "./remote-value.ts";
import { linkedAlternativeHint } from "./target-identity.ts";
import { parseTargetSelector, type TargetSelectorInput } from "./target-selector.ts";
import { TargetPolicy } from "./target-policy.ts";

export type ResolvedTarget =
  | { readonly kind: "local" }
  | {
      readonly kind: "linked";
      readonly ref: string;
      readonly source: ProjectRefSource;
      readonly matchesLinkedRef: boolean;
    }
  | { readonly kind: "db-url"; readonly url: Redacted.Redacted<string> };

export type LinkedTarget = Extract<ResolvedTarget, { readonly kind: "linked" }>;

type SelectedBy = "flag" | "default";

/** The linked target for a ref the ref chain has already resolved and announced. */
export const linkedTarget = (resolved: ResolvedProjectRef): LinkedTarget => ({
  kind: "linked",
  ref: resolved.ref,
  source: resolved.source,
  matchesLinkedRef: resolved.matchesLinkedRef,
});

/** The linked target for one hosted `--remote` value; announces it, as a branch when the value names one. */
export const resolveRemoteTarget = Effect.fn("Target.resolveRemote")(function* (
  remote: Exclude<RemoteValue, { readonly _tag: "DbUrl" }>,
) {
  if (remote._tag === "Branch") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { workdir } = yield* CommandSettings;
    const found = yield* resolveRemoteBranch(remote.name);
    const linkedRef = yield* readProjectRefFile(fs, path, workdir).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return linkedTarget({
      ref: found.projectRef,
      source: "flag",
      matchesLinkedRef: Option.isSome(linkedRef) && linkedRef.value === found.projectRef,
    });
  }
  const projectRef = yield* ProjectRefResolver;
  return linkedTarget(
    yield* projectRef.resolveRef(remote._tag === "Ref" ? Option.some(remote.ref) : Option.none()),
  );
});

/**
 * Resolves the target a `selectable` command acts on: `--remote` (or a deprecated alias) picks a
 * linked project, a branch or a database URL, and no selector means the local stack.
 */
export const resolveTarget = Effect.fn("Target.resolve")(function* (input: TargetSelectorInput) {
  const policy = yield* TargetPolicy;
  if (policy.group !== "selectable") {
    return yield* Effect.die(
      new Error(`resolveTarget needs a selectable command, not "${policy.group}"`),
    );
  }
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(
      input,
      Option.isSome(runtime)
        ? { commandName: `\`supabase ${getCommandRuntimeCommand(runtime.value)}\`` }
        : {},
    ),
    { onFailure: Effect.fail, onSuccess: Effect.succeed },
  );
  yield* warnTargetDeprecations(deprecations);

  const finish = Effect.fnUntraced(function* (target: ResolvedTarget, selectedBy: SelectedBy) {
    yield* Effect.annotateCurrentSpan({
      "target.kind": target.kind,
      "target.selection": selectedBy,
    });
    return target;
  });
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

  switch (selection.explicit) {
    case "local":
      return yield* finish({ kind: "local" }, "flag");
    case "db-url":
      return yield* finish({ kind: "db-url", url: Redacted.make(selection.url) }, "flag");
    case "linked": {
      if (Option.isNone(selection.ref)) yield* rejectAmbiguousRemote(input.remote);
      const remote: RemoteValue = Option.isSome(selection.ref)
        ? { _tag: "Ref", ref: selection.ref.value }
        : { _tag: "Linked" };
      return yield* finish(yield* resolveRemoteTarget(remote), "flag");
    }
    case "branch":
      return yield* finish(
        yield* resolveRemoteTarget({ _tag: "Branch", name: selection.name }),
        "flag",
      );
    case undefined:
      yield* hintLinkedAlternative();
      return yield* finish({ kind: "local" }, "default");
  }
});
