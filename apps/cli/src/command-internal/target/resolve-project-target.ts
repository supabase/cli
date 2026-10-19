import { Effect, Option, Result } from "effect";

import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import { resolveParentScopedProjectRef } from "../parent-project-ref.ts";
import { resolveRemoteTarget } from "./resolve-target.ts";
import { rejectAmbiguousRemote, warnTargetDeprecations } from "./remote-resolution.ts";
import type { RemoteValue } from "./remote-value.ts";
import { parseTargetSelector } from "./target-selector.ts";
import { TargetNeedsProjectError } from "./target.errors.ts";

export interface ProjectTargetInput {
  readonly remote: Option.Option<RemoteValue>;
  readonly projectRef: Option.Option<string>;
}

interface ParentProjectTargetOptions {
  /** A command that acts on a parent project, such as `branches *`: its `--remote` takes a ref, never a branch name. */
  readonly parent: true;
}

interface RequestedProjectTargetOptions<A, E, R> {
  /** Resolves the ref or branch name `--remote` names with the caller's own lookup, for a command with no operands. */
  readonly resolveRequested: (requested: Option.Option<string>) => Effect.Effect<A, E, R>;
}

const selectProject = Effect.fnUntraced(function* (input: ProjectTargetInput) {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const commandName = Option.isSome(runtime)
    ? `\`supabase ${getCommandRuntimeCommand(runtime.value)}\``
    : undefined;
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(
      { ...input, local: false, linked: false },
      commandName === undefined ? {} : { commandName },
    ),
    { onFailure: Effect.fail, onSuccess: Effect.succeed },
  );
  yield* warnTargetDeprecations(deprecations);
  return { selection, commandName: commandName ?? "This command" };
});

const unreachableSelection = (explicit: "local" | "db-url") =>
  Effect.die(new Error(`a project-only selector cannot select "${explicit}"`));

const resolveHosted = Effect.fn("Target.resolveProject")(function* (input: ProjectTargetInput) {
  const { selection } = yield* selectProject(input);
  switch (selection.explicit) {
    case "branch":
      return (yield* resolveRemoteTarget({ _tag: "Branch", name: selection.name })).ref;
    case "linked": {
      if (Option.isNone(selection.ref)) yield* rejectAmbiguousRemote(input.remote);
      const remote: RemoteValue = Option.isSome(selection.ref)
        ? { _tag: "Ref", ref: selection.ref.value }
        : { _tag: "Linked" };
      return (yield* resolveRemoteTarget(remote)).ref;
    }
    case undefined:
      return (yield* resolveRemoteTarget({ _tag: "Linked" })).ref;
    case "local":
    case "db-url":
      return yield* unreachableSelection(selection.explicit);
  }
});

const resolveParent = Effect.fn("Target.resolveProject")(function* (input: ProjectTargetInput) {
  const { selection, commandName } = yield* selectProject(input);
  switch (selection.explicit) {
    case "branch":
      return yield* new TargetNeedsProjectError({
        message: `${commandName} acts on a parent project, so --remote takes its project ref, not a branch name. Use --remote=<ref>.`,
      });
    case "linked":
      return yield* resolveParentScopedProjectRef(selection.ref);
    case undefined:
      return yield* resolveParentScopedProjectRef(Option.none());
    case "local":
    case "db-url":
      return yield* unreachableSelection(selection.explicit);
  }
});

const resolveRequested = Effect.fn("Target.resolveProject")(function* <A, E, R>(
  input: ProjectTargetInput,
  resolve: (requested: Option.Option<string>) => Effect.Effect<A, E, R>,
) {
  const { selection } = yield* selectProject(input);
  switch (selection.explicit) {
    case "branch":
      return yield* resolve(Option.some(selection.name));
    case "linked":
      return yield* resolve(selection.ref);
    case undefined:
      return yield* resolve(Option.none());
    case "local":
    case "db-url":
      return yield* unreachableSelection(selection.explicit);
  }
});

/**
 * Resolves the project a hosted-only command acts on: `--remote=<ref|branch>` names one, and a
 * bare `--remote` or no selector falls through to the project-ref chain (`SUPABASE_PROJECT_ID`,
 * the link file, the picker).
 */
export function resolveProjectTarget(input: ProjectTargetInput): ReturnType<typeof resolveHosted>;
export function resolveProjectTarget(
  input: ProjectTargetInput,
  options: ParentProjectTargetOptions,
): ReturnType<typeof resolveParent>;
export function resolveProjectTarget<A, E, R>(
  input: ProjectTargetInput,
  options: RequestedProjectTargetOptions<A, E, R>,
): Effect.Effect<
  A,
  E | Effect.Error<ReturnType<typeof selectProject>>,
  R | Effect.Services<ReturnType<typeof selectProject>>
>;
export function resolveProjectTarget<A, E, R>(
  input: ProjectTargetInput,
  options?: ParentProjectTargetOptions | RequestedProjectTargetOptions<A, E, R>,
) {
  if (options === undefined) return resolveHosted(input);
  return "resolveRequested" in options
    ? resolveRequested(input, options.resolveRequested)
    : resolveParent(input);
}
