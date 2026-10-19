import { Effect, Option, Result } from "effect";

import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import { resolveRemoteTarget } from "./resolve-target.ts";
import { rejectAmbiguousRemote, warnTargetDeprecations } from "./remote-resolution.ts";
import type { RemoteValue } from "./remote-value.ts";
import { parseTargetSelector } from "./target-selector.ts";

export interface ProjectTargetInput {
  readonly remote: Option.Option<RemoteValue>;
  readonly projectRef: Option.Option<string>;
}

/**
 * Resolves the project a hosted-only command acts on: `--remote=<ref|branch>` names one, and a
 * bare `--remote` or no selector falls through to the project-ref chain (`SUPABASE_PROJECT_ID`,
 * the link file, the picker).
 */
export const resolveProjectTarget = Effect.fn("Target.resolveProject")(function* (
  input: ProjectTargetInput,
) {
  const runtime = yield* Effect.serviceOption(CommandRuntime);
  const { selection, deprecations } = yield* Result.match(
    parseTargetSelector(
      { ...input, local: false, linked: false },
      Option.isSome(runtime)
        ? { commandName: `\`supabase ${getCommandRuntimeCommand(runtime.value)}\`` }
        : {},
    ),
    { onFailure: Effect.fail, onSuccess: Effect.succeed },
  );
  yield* warnTargetDeprecations(deprecations);

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
      return yield* Effect.die(
        new Error(`a project-only selector cannot select "${selection.explicit}"`),
      );
  }
});
