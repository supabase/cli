import { Effect, Match } from "effect";
import {
  type StackDescriptor,
  type StackDiscoveryError,
  type StackDiscoveryIssue,
  type StackRuntime,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { renderGlamourTable } from "../../../../output/glamour-table.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { StackApi, rejectStackOutput } from "../stack.shared.ts";
import { StackCommandListError } from "./list.errors.ts";

const readableEntry = (descriptor: StackDescriptor) => ({
  id: descriptor.id,
  readable: true as const,
  project_root: descriptor.projectRoot,
  name: descriptor.name,
  branch_context: descriptor.branchContext,
  runtime: descriptor.runtime,
  desired_lifecycle: descriptor.desiredLifecycle,
});

const unreadableEntry = ({ id, error }: StackDiscoveryIssue) => ({
  id,
  readable: false as const,
  error: {
    code: error._tag,
    message: error.message,
  },
});

type ReadableEntry = ReturnType<typeof readableEntry>;
type UnreadableEntry = ReturnType<typeof unreadableEntry>;
type StackEntry = ReadableEntry | UnreadableEntry;

const compareCodeunit = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareEntries = (left: ReadableEntry, right: ReadableEntry): number => {
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

const compactId = (id: string): string => id.slice(0, 8);

const render = (stacks: ReadonlyArray<StackEntry>): string => {
  if (stacks.length === 0) return "No managed stacks found.\n";
  const readable = stacks.filter((stack): stack is ReadableEntry => stack.readable);
  const unreadable = stacks.filter((stack): stack is UnreadableEntry => !stack.readable);
  const lines: string[] = [];
  if (readable.length > 0) {
    lines.push(
      renderGlamourTable(
        ["NAME", "PROJECT", "BRANCH", "RUNTIME", "DESIRED", "ID"],
        readable.map((stack) => [
          stack.name,
          stack.project_root,
          stack.branch_context,
          renderRuntime(stack.runtime),
          stack.desired_lifecycle,
          compactId(stack.id),
        ]),
      ).trimEnd(),
    );
  }
  if (unreadable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Unreadable stacks:");
    for (const stack of unreadable) {
      lines.push(`  ${stack.error.code}: ${stack.error.message}`);
    }
  }
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
    const readable = result.stacks.map(readableEntry).sort(compareEntries);
    const unreadable = result.errors
      .map(unreadableEntry)
      .sort((left, right) => compareCodeunit(left.id, right.id));
    const stacks: ReadonlyArray<StackEntry> = [...readable, ...unreadable];
    if (output.format === "text") yield* output.raw(render(stacks));
    else yield* output.success("", { stacks });
    return stacks;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
