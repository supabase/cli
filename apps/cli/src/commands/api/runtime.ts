import { Array as Arr, Cause, Effect, Exit, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { ApiCommandUsageError } from "../../command-internal/command-errors/api-command.errors.ts";
import { withStandardErrors } from "../../command-internal/command-errors/command-errors.annotation.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, type OperationEntry } from "../../command-internal/command-permissions/model.ts";
import {
  type CommandStage,
  withCommandStage,
} from "../../command-internal/command-stage/command-stage.annotation.ts";
import { parseDuration } from "../../command-internal/duration.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../command-internal/hosted-consent/hosted-consent.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { resolveProjectTarget } from "../../command-internal/target/resolve-project-target.ts";
import { projectTargetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { readExplicitOutputFormat } from "../../shared/cli/agent-output.ts";
import { Output } from "../../shared/output/output.service.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  type ApiOutputFormat,
  linkedReadInput,
  sendApiRequest,
  waitForOperation,
  writeApiResponse,
  writeDryRun,
} from "./api-command-execute.ts";
import { type ApiFlagLocation, apiFlag } from "./api-command-flags.ts";
import { type ApiNoun, nouns } from "./api-command-policy.ts";
import {
  assembleInput,
  decodeInput,
  previewRequest,
  readBodyOverride,
} from "./api-command-request.ts";
import { withApiCommand } from "./api-command.annotation.ts";
import type {
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandWait,
  ApiPollRead,
} from "./api-command.model.ts";
import { apiCommands, apiPollTargets } from "./generated.ts";

const DEFAULT_WAIT_TIMEOUT = "10m";
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const stageOf = (entry: ApiCommandEntry): CommandStage => ({
  status: "experimental",
  feature: entry.feature,
});

/** A command's `--wait`: the wait declared on its entry and the entry of the operation it polls. */
interface ResolvedWait {
  readonly wait: ApiCommandWait;
  readonly readEntry: ApiPollRead;
  readonly statusEntry: ApiCommandEntry;
}

const resolveWait = (
  entry: ApiCommandEntry,
  entries: ReadonlyArray<ApiCommandEntry>,
): ResolvedWait | undefined => {
  const { wait } = entry;
  if (wait === undefined) return undefined;
  const publicRead = entries.find((candidate) => candidate.operationId === wait.read);
  if (publicRead !== undefined) return { wait, readEntry: publicRead, statusEntry: publicRead };
  const hidden = apiPollTargets.find((candidate) => candidate.operationId === wait.read);
  const inspect = entries.find((candidate) => candidate.operationId === hidden?.inspect);
  return hidden === undefined || inspect === undefined
    ? undefined
    : { wait, readEntry: hidden, statusEntry: inspect };
};

const flagLocation = (entry: ApiCommandEntry, flag: ApiCommandFlag): ApiFlagLocation => {
  for (const binding of entry.bindings) {
    if (binding.source === "flag" && binding.flag === flag.name) return binding.location;
  }
  return "body";
};

/** The config of a generated command: target flags, runtime flags, one flag per API field and the positional. */
const flagConfig = (entry: ApiCommandEntry, waitable: boolean) => ({
  ...projectTargetFlags(),
  ...(entry.argument === undefined
    ? {}
    : {
        argument: Argument.String(entry.argument.name).pipe(
          Argument.withDescription(entry.argument.description ?? `Set ${entry.argument.name}.`),
        ),
      }),
  ...(entry.body === undefined
    ? {}
    : {
        body: Flag.optional(
          Flag.String("body").pipe(
            Flag.withDescription(
              "Whole request body as JSON; other flags replace fields at their own location.",
            ),
          ),
        ),
        file: Flag.optional(
          Flag.String("file").pipe(
            Flag.withDescription("Read the whole request body from a JSON file, or - for stdin."),
          ),
        ),
      }),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the request that would be sent and send nothing."),
    Flag.withDefault(false),
  ),
  ...(!waitable
    ? {}
    : {
        wait: Flag.Boolean("wait").pipe(
          Flag.withDescription("Wait until the operation reaches a final status."),
          Flag.withDefault(false),
        ),
        timeout: Flag.String("timeout").pipe(
          Flag.withDescription("How long --wait polls, as a duration such as 90s or 10m."),
          Flag.withDefault(DEFAULT_WAIT_TIMEOUT),
        ),
      }),
  api: Object.fromEntries(
    entry.flags.map((flag) => [flag.name, apiFlag(flag, flagLocation(entry, flag))]),
  ),
});

const parseTimeoutMillis = (value: string) =>
  Effect.try({
    try: () => parseDuration(value) / NANOSECONDS_PER_MILLISECOND,
    catch: () =>
      new ApiCommandUsageError({
        message: `--timeout ${value} is not a valid duration.`,
        hint: "Use a duration such as 90s or 10m.",
      }),
  }).pipe(
    Effect.filterOrFail(
      (millis) => millis > 0,
      () =>
        new ApiCommandUsageError({
          message: `--timeout ${value} must be greater than zero.`,
          hint: "Use a duration such as 90s or 10m.",
        }),
    ),
  );

const summaryText = (entry: Pick<ApiCommandEntry, "summary">): string =>
  entry.summary.replace(/\.$/, "");

const OUTPUT_FORMATS: ReadonlyArray<string> = ["json", "yaml", "pretty"];

/**
 * How the result prints: `-o` decides first, then an explicit `--output-format`, then text only
 * for a text-mode run on a terminal; everything else keeps the API's JSON.
 */
const presentationOf = (input: {
  readonly outputFlag: Option.Option<string>;
  readonly args: ReadonlyArray<string>;
  readonly outputFormat: OutputFormat;
  readonly stdoutIsTty: boolean;
}): ApiOutputFormat => {
  const flag = Option.getOrUndefined(input.outputFlag);
  if (flag === "yaml") return "yaml";
  if (flag === "json") return "json";
  if (flag === "pretty") return "text";
  const explicit = readExplicitOutputFormat(input.args);
  if (Option.isSome(explicit)) return explicit.value === "text" ? "text" : "json";
  return input.outputFormat === "text" && input.stdoutIsTty ? "text" : "json";
};

/**
 * Runs `use` under a progress task when `visible`, handing it the task's message updater; the
 * task is cleared on success and marked failed or cancelled otherwise.
 */
const withTask = <A, E, R>(
  visible: boolean,
  message: string,
  use: (update: (message: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!visible) return yield* use(() => Effect.void);
    const output = yield* Output;
    const task = yield* output.task(message);
    return yield* use(task.message).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? task.clear
          : Cause.hasInterruptsOnly(exit.cause)
            ? task.cancel()
            : task.fail(),
      ),
    );
  });

/** The parsed flags of a generated command. */
interface ApiCommandFlags {
  readonly remote: Parameters<typeof resolveProjectTarget>[0]["remote"];
  readonly projectRef: Parameters<typeof resolveProjectTarget>[0]["projectRef"];
  readonly argument?: string;
  readonly body?: Option.Option<string>;
  readonly file?: Option.Option<string>;
  readonly dryRun: boolean;
  readonly wait?: boolean;
  readonly timeout?: string;
  readonly api: Parameters<typeof assembleInput>[2];
}

/** Runs one generated command: assemble and validate the request, consent, send, optionally wait, print. */
const handle = Effect.fn("api-command.run")(function* (
  entry: ApiCommandEntry,
  resolved: ResolvedWait | undefined,
  flags: ApiCommandFlags,
) {
  yield* Effect.annotateCurrentSpan("operation.id", entry.operationId);
  const telemetryState = yield* TelemetryState;
  const cache = yield* LinkedProjectCache;
  const output = yield* Output;
  const format = presentationOf({
    outputFlag: yield* OutputFlag,
    args: (yield* CliArgs).args,
    outputFormat: output.format,
    stdoutIsTty: (yield* Tty).stdoutIsTty,
  });
  const progress = format === "text" && output.format === "text";
  yield* Effect.annotateCurrentSpan("output.presentation", format);
  yield* Effect.gen(function* () {
    const ref = yield* resolveProjectTarget(flags);
    yield* Effect.gen(function* () {
      const waiting = resolved !== undefined && flags.wait === true;
      const timeoutMillis = waiting
        ? yield* parseTimeoutMillis(flags.timeout ?? DEFAULT_WAIT_TIMEOUT)
        : 0;
      const override = yield* readBodyOverride({
        body: flags.body ?? Option.none(),
        file: flags.file ?? Option.none(),
      });
      const input = yield* assembleInput(entry, ref, flags.api, override, flags.argument);
      const decoded = yield* decodeInput(entry, input);

      if (flags.dryRun) {
        yield* Effect.annotateCurrentSpan("run.outcome", "dry_run");
        return yield* writeDryRun(previewRequest(entry, decoded), format);
      }
      if (!entry.readOnly) {
        yield* requireHostedMutationConsent({ action: summaryText(entry) });
      }

      if (waiting) {
        // A read that polls itself needs no change request: its own input is what gets polled.
        const selfPolling = resolved.readEntry.operationId === entry.operationId;
        const readInput = selfPolling
          ? input
          : yield* linkedReadInput({
              wait: resolved.wait,
              changedOperationId: entry.operationId,
              ref,
              changed: yield* withTask(progress, summaryText(entry), () =>
                sendApiRequest(entry, decoded),
              ),
            });
        const polling = summaryText(resolved.readEntry);
        const settled = yield* withTask(progress, polling, (update) =>
          waitForOperation({
            wait: resolved.wait,
            readEntry: resolved.readEntry,
            statusEntry: resolved.statusEntry,
            readInput,
            ref,
            timeoutMillis,
            onPoll: (status) =>
              update(status === undefined ? polling : `${polling} (status: ${status})`),
          }),
        );
        yield* Effect.annotateCurrentSpan("run.outcome", "waited");
        return yield* writeApiResponse(resolved.readEntry, settled, format);
      }
      const response = yield* withTask(progress, summaryText(entry), () =>
        sendApiRequest(entry, decoded),
      );
      yield* Effect.annotateCurrentSpan("run.outcome", "sent");
      return yield* writeApiResponse(entry, response, format);
    }).pipe(Effect.ensuring(cache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});

const exampleFor = (entry: ApiCommandEntry): string => {
  const required = entry.flags
    .filter(
      (flag) =>
        flag.required &&
        !entry.bindings.some(
          (binding) => binding.location === "body" && binding.flag === flag.name,
        ),
    )
    .map((flag) => `--${flag.name}${flag.type === "boolean" ? "" : ` <${flag.name}>`}`);
  const positional = entry.argument === undefined ? [] : [`<${entry.argument.name}>`];
  const body = entry.body === undefined ? [] : ["--file <path>"];
  return ["supabase", ...entry.command, ...positional, ...required, ...body].join(" ");
};

const permissionsOf = (entry: ApiCommandEntry, resolved: ResolvedWait | undefined) => {
  const polled = resolved?.readEntry.operationId;
  const operations: ReadonlyArray<OperationEntry> = [
    { operationId: entry.operationId, kind: "required" },
    ...(polled === undefined || polled === entry.operationId
      ? []
      : [
          {
            operationId: polled,
            kind: "required" as const,
            when: [{ flag: "wait", is: true }],
          },
        ]),
  ];
  const noApiEffectFlags = [
    "dry-run",
    ...(entry.body === undefined ? [] : ["body", "file"]),
    ...(resolved === undefined ? [] : ["timeout"]),
    ...(polled === entry.operationId ? ["wait"] : []),
    ...entry.flags.map((flag) => flag.name),
  ];
  return compose(
    { operations, noApiEffectFlags },
    projectRefPicker,
    linkedProjectCache,
    branchResolution,
  );
};

const leafOf = (entry: ApiCommandEntry, entries: ReadonlyArray<ApiCommandEntry>) => {
  const verb = entry.command[entry.command.length - 1] ?? entry.operationId;
  const resolved = resolveWait(entry, entries);
  const config = flagConfig(entry, resolved !== undefined);
  return Command.make(verb, config).pipe(
    Command.withDescription(entry.description ?? entry.summary),
    Command.withShortDescription(`${entry.summary} (experimental)`),
    Command.withExamples([{ command: exampleFor(entry), description: entry.summary }]),
    withApiCommand({
      operationId: entry.operationId,
      bindings: entry.bindings,
      response: entry.response,
    }),
    withPermissions(permissionsOf(entry, resolved)),
    withCommandStage(stageOf(entry)),
    withStandardErrors,
    Command.withHandler((flags) => {
      const { api: _generated, argument: _argument, ...recorded } = flags;
      return handle(entry, resolved, flags).pipe(
        withCommandTelemetry({ flags: recorded, outputFormats: OUTPUT_FORMATS }),
      );
    }),
    // `stdinLayer`: `--file -` reads the request body from piped stdin.
    Command.provide(Layer.mergeAll(managementApiRuntimeLayer(entry.command), stdinLayer)),
    withTargetPolicy({ group: "hosted", consent: entry.readOnly ? "none" : "no" }),
  );
};

type ApiLeaf = ReturnType<typeof leafOf>;

/** A command with generated commands merged in: it fails and requires what `C` and the generated leaves do. */
type WithApi<C> = Command.Command<
  string,
  {},
  {},
  Command.Error<C> | Command.Error<ApiLeaf>,
  Command.Services<C> | Command.Services<ApiLeaf>
>;

type Subcommands = ReadonlyArray<Command.Command.SubcommandEntry>;

/** The noun definitions and entries the generated commands are built from. */
interface ApiCommandSource {
  readonly nouns: Readonly<Record<string, ApiNoun>>;
  readonly entries: ReadonlyArray<ApiCommandEntry>;
}

const startsWith = (command: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.every((word, index) => command[index] === word);

const leafCache = new WeakMap<ApiCommandEntry, ApiLeaf>();

const cachedLeaf = (entry: ApiCommandEntry, entries: ReadonlyArray<ApiCommandEntry>): ApiLeaf => {
  const cached = leafCache.get(entry);
  if (cached !== undefined) return cached;
  const leaf = leafOf(entry, entries);
  leafCache.set(entry, leaf);
  return leaf;
};

const groupDescription = (path: ReadonlyArray<string>, noun: ApiNoun): string | undefined =>
  path.length === 1 ? noun.description : noun.groups?.[path.slice(1).join(".")];

/** The group at `path`, taking the generated commands below it; `existing` is the hand-written group it joins. */
const groupAt = (
  existing: Command.Command.Any | undefined,
  path: ReadonlyArray<string>,
  noun: ApiNoun,
  entries: ReadonlyArray<ApiCommandEntry>,
): Command.Command.Any => {
  const name = path[path.length - 1] ?? "";
  const under = entries.filter((entry) => startsWith(entry.command, path));
  const childNames = new Set(
    under.flatMap((entry) =>
      entry.command.length > path.length + 1
        ? entry.command.slice(path.length, path.length + 1)
        : [],
    ),
  );
  const existingChildren = existing?.subcommands ?? [];
  const existingNames = new Set(
    existingChildren.flatMap(({ commands }) => commands.map((child) => child.name)),
  );
  const joined = existingChildren.flatMap(({ group, commands }): Subcommands => {
    const children = Arr.map(commands, (child) =>
      childNames.has(child.name) ? groupAt(child, [...path, child.name], noun, entries) : child,
    );
    return group === undefined ? children : [{ group, commands: children }];
  });
  const leaves = under
    .filter((entry) => entry.command.length === path.length + 1)
    .map((entry) => cachedLeaf(entry, entries));
  const created = [...childNames]
    .filter((child) => !existingNames.has(child))
    .map((child) => groupAt(undefined, [...path, child], noun, entries));
  const description = `${groupDescription(path, noun) ?? name} (experimental)`;
  const base =
    existing ??
    Command.make(name).pipe(
      Command.withDescription(description),
      Command.withShortDescription(description),
    );
  return Command.withSubcommands(base, [...joined, ...leaves, ...created]);
};

/**
 * `handWritten` with the generated Management API commands of every enabled noun merged in: a
 * noun named like a hand-written command adds its commands and sub-groups to that command at any
 * depth, and any other noun becomes a new group in alphabetical position.
 */
export const withApiCommands = <const C extends ReadonlyArray<Command.Command.Any>>(
  handWritten: C,
  enabledFeatures: ReadonlyArray<string>,
  source: ApiCommandSource = { nouns, entries: apiCommands },
): ReadonlyArray<C[number] | WithApi<C[number]>> => {
  const merged: Array<Command.Command.Any> = [...handWritten];
  for (const [name, noun] of Object.entries(source.nouns)) {
    if (!enabledFeatures.includes(noun.feature)) continue;
    const index = merged.findIndex((command) => command.name === name);
    if (index >= 0) {
      merged[index] = groupAt(merged[index], [name], noun, source.entries);
    } else {
      const position = merged.findIndex((command) => command.name > name);
      merged.splice(
        position < 0 ? merged.length : position,
        0,
        groupAt(undefined, [name], noun, source.entries),
      );
    }
  }
  return merged;
};
