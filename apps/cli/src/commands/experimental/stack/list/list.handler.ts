import { Effect, Match, Option } from "effect";
import { isStackError, type StackDescriptor, type StackError } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { LegacyExperimentalStackListError } from "./list.errors.ts";

const entry = (descriptor: StackDescriptor) => ({
  id: descriptor.id,
  project_root: descriptor.projectRoot,
  name: descriptor.name,
  branch_context: descriptor.branchContext,
  runtime: descriptor.runtime,
  desired_lifecycle: descriptor.desiredLifecycle,
});

const compareCodepoint = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareEntries = (
  left: ReturnType<typeof entry>,
  right: ReturnType<typeof entry>,
): number => {
  const project = compareCodepoint(left.project_root, right.project_root);
  if (project !== 0) return project;
  const name = compareCodepoint(left.name, right.name);
  return name !== 0 ? name : compareCodepoint(left.id, right.id);
};

const mapStackError = (error: StackError) => {
  const reason = Match.value(error).pipe(
    Match.tag(
      "InvalidStackIdentityError",
      "InvalidProjectRootError",
      "StackStateInvalidError",
      "StackStateFormatUnsupportedError",
      () => "invalid-config" as const,
    ),
    Match.orElse(() => "runtime" as const),
  );
  return new LegacyExperimentalStackListError({ reason, message: error.message });
};

const render = (stacks: ReadonlyArray<ReturnType<typeof entry>>): string => {
  if (stacks.length === 0) return "No managed stacks found.\n";
  return `${stacks.map((stack) => `${stack.name} (${stack.id})\n  Project: ${stack.project_root}\n  Branch: ${stack.branch_context}\n  Runtime: ${stack.runtime.kind}\n  Desired lifecycle: ${stack.desired_lifecycle}`).join("\n\n")}\n`;
};

export const legacyExperimentalStackList = Effect.fn("legacy.experimental.stack.list")(
  function* () {
    const output = yield* Output;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackListError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
      });
    const api = yield* LegacyExperimentalStackApi;
    const stacks = (yield* api
      .listStacks()
      .pipe(Effect.catchIf(isStackError, (error) => Effect.fail(mapStackError(error)))))
      .map(entry)
      .sort(compareEntries);
    if (output.format === "text") yield* output.raw(render(stacks));
    else yield* output.success("", { stacks });
    return stacks;
  },
);
