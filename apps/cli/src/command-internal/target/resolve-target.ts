import { Effect, FileSystem, Option, Path, Redacted, Result } from "effect";

import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import {
  PROJECT_REF_PATTERN,
  ProjectRefResolver,
  type ProjectRefSource,
  type ResolvedProjectRef,
} from "../../config/project-ref.service.ts";
import { CliConfigLoadError } from "../../shared/config/cli-config-load.errors.ts";
import { readProjectRefFile } from "../../shared/config/temp-paths.ts";
import { CommandTarget } from "../../shared/output/command-target.service.ts";
import { readCachedLinkedProject } from "../parent-project-ref.ts";
import { describeConfigParseError } from "../workdir-project.ts";
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

type TargetSelection = "flag" | "env" | "config" | "default";

/** The linked target for a ref the ref chain has already resolved and announced. */
export const linkedTarget = (resolved: ResolvedProjectRef): LinkedTarget => ({
  kind: "linked",
  ref: resolved.ref,
  source: resolved.source,
  matchesLinkedRef: resolved.matchesLinkedRef,
});

/**
 * Resolves the target a `sync` or `selectable` command acts on: a selector flag wins, then
 * `sync` means the linked project and `selectable` follows the workspace `target`. Linked goes
 * through {@link ProjectRefResolver.resolveRef}, which announces it.
 */
export const resolveTarget = Effect.fn("Target.resolve")(function* (input: TargetSelectorInput) {
  const policy = yield* TargetPolicy;
  if (policy.group !== "sync" && policy.group !== "selectable") {
    return yield* Effect.die(
      new Error(`resolveTarget needs a sync or selectable command, not "${policy.group}"`),
    );
  }
  const selection = yield* Result.match(parseTargetSelector(input), {
    onFailure: Effect.fail,
    onSuccess: Effect.succeed,
  });
  const projectRef = yield* ProjectRefResolver;

  const finish = Effect.fnUntraced(function* (target: ResolvedTarget, selectedBy: TargetSelection) {
    yield* Effect.annotateCurrentSpan({
      "target.kind": target.kind,
      "target.selection": selectedBy,
    });
    return target;
  });
  const linked = Effect.fnUntraced(function* (flag: Option.Option<string>) {
    return linkedTarget(yield* projectRef.resolveRef(flag));
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
    case "linked":
      return yield* finish(yield* linked(selection.projectRef), "flag");
    case undefined:
  }

  if (policy.group === "sync") {
    return yield* finish(yield* linked(Option.none()), "default");
  }
  const { workdir } = yield* CommandSettings;
  const resolvedConfig = yield* (yield* CliConfigValues)
    .load({ workdir, projectRef: Option.none() })
    .pipe(
      Effect.catchTag("CliConfigParseError", (error) =>
        Effect.fail(new CliConfigLoadError({ message: describeConfigParseError(workdir, error) })),
      ),
    );
  const workspaceTarget = yield* resolvedConfig.get(CliConfigKeys.target);
  const selectedBy: TargetSelection =
    workspaceTarget.origin.tier === "shell" || workspaceTarget.origin.tier === "projectEnv"
      ? "env"
      : workspaceTarget.origin.tier === "config"
        ? "config"
        : "default";
  if (workspaceTarget.value === "remote") {
    return yield* finish(yield* linked(Option.none()), selectedBy);
  }
  yield* hintLinkedAlternative();
  return yield* finish({ kind: "local" }, selectedBy);
});
