import { Effect, Match } from "effect";
import {
  type StackDescriptor,
  type StackDiscoveryError,
  type StackRuntime,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { StackApi, rejectStackOutput } from "../stack.shared.ts";
import { StackCommandListError } from "./list.errors.ts";

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
  new StackCommandListError({
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

export const stackList = Effect.fn("experimental.stack.list")(function* () {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandListError({
            reason: error.reason,
            message: error.message,
            ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
            cause: error,
          }),
      ),
    );
    const api = yield* StackApi;
    const result = yield* api.discoverStacks().pipe(Effect.mapError(mapStackError));
    const stacks = result.stacks.map(entry).sort(compareEntries);
    const firstError = result.errors[0];
    if (firstError !== undefined) return yield* mapStackError(firstError.error);
    if (output.format === "text") yield* output.raw(render(stacks));
    else yield* output.success("", { stacks });
    return stacks;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
