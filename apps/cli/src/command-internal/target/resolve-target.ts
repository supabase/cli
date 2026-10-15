import { Effect, Option, Redacted, Result } from "effect";

import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver, type ProjectRefSource } from "../../config/project-ref.service.ts";
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

type TargetSelection = "flag" | "env" | "config" | "default";

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
    const resolved = yield* projectRef.resolveRef(flag);
    return {
      kind: "linked",
      ref: resolved.ref,
      source: resolved.source,
      matchesLinkedRef: resolved.matchesLinkedRef,
    } satisfies ResolvedTarget;
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
  const resolvedConfig = yield* (yield* CliConfigValues).load({
    workdir,
    projectRef: Option.none(),
  });
  const workspaceTarget = yield* resolvedConfig.get(CliConfigKeys.target);
  const selectedBy: TargetSelection =
    workspaceTarget.origin.tier === "shell" || workspaceTarget.origin.tier === "projectEnv"
      ? "env"
      : workspaceTarget.origin.tier === "config"
        ? "config"
        : "default";
  return yield* finish(
    workspaceTarget.value === "remote" ? yield* linked(Option.none()) : { kind: "local" },
    selectedBy,
  );
});
