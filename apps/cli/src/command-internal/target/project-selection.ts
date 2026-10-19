import { Effect, Option, Result } from "effect";

import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../shared/runtime/command-runtime.service.ts";
import { warnTargetDeprecations } from "./remote-resolution.ts";
import type { ProjectTargetInput } from "./resolve-project-target.ts";
import { parseTargetSelector } from "./target-selector.ts";

/**
 * Parses the `--remote` and deprecated `--project-ref` of a hosted command and prints the alias
 * warnings, leaving the lookup to the caller; a database URL fails as a selector error.
 */
export const selectProject = Effect.fn("Target.selectProject")(function* (
  input: ProjectTargetInput,
) {
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
