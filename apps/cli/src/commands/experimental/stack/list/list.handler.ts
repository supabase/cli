import { Effect, Match, Option } from "effect";
import {
  type StackDescriptor,
  type StackDiscoveryError,
  type StackRuntime,
} from "@supabase/stack/effect";
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

const compareCodeunit = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareEntries = (
  left: ReturnType<typeof entry>,
  right: ReturnType<typeof entry>,
): number => {
  const project = compareCodeunit(left.project_root, right.project_root);
  if (project !== 0) return project;
  const name = compareCodeunit(left.name, right.name);
  return name !== 0 ? name : compareCodeunit(left.id, right.id);
};

const mapStackError = (error: StackDiscoveryError) =>
  new LegacyExperimentalStackListError({
    reason: "invalid-config",
    message: error.message,
    suggestion:
      "Inspect the managed stack registry under $SUPABASE_HOME/managed/stacks or ~/.supabase/managed/stacks.",
    cause: error,
  });

const renderRuntime = (runtime: StackRuntime): string =>
  Match.value(runtime).pipe(
    Match.when({ kind: "native" }, () => "native"),
    Match.when({ kind: "container" }, ({ engine }) => `container (${engine})`),
    Match.exhaustive,
  );

const render = (stacks: ReadonlyArray<ReturnType<typeof entry>>): string => {
  if (stacks.length === 0) return "No managed stacks found.\n";
  const lines = stacks.flatMap((stack, index) => [
    ...(index === 0 ? [] : [""]),
    `${stack.name} (${stack.id})`,
    `  Project: ${stack.project_root}`,
    `  Branch: ${stack.branch_context}`,
    `  Runtime: ${renderRuntime(stack.runtime)}`,
    `  Desired lifecycle: ${stack.desired_lifecycle}`,
  ]);
  return `${lines.join("\n")}\n`;
};

export const legacyExperimentalStackList = Effect.fn("legacy.experimental.stack.list")(
  function* () {
    const output = yield* Output;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackListError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion: "Use --output-format json or --output-format text.",
      });
    const api = yield* LegacyExperimentalStackApi;
    const stacks = (yield* api.listStacks().pipe(Effect.mapError(mapStackError)))
      .map(entry)
      .sort(compareEntries);
    if (output.format === "text") yield* output.raw(render(stacks));
    else yield* output.success("", { stacks });
    return stacks;
  },
);
