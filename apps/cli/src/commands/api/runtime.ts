import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { ApiCommandUsageError } from "../../command-internal/command-errors/api-command.errors.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  type OperationEntry,
  withCondition,
} from "../../command-internal/command-permissions/model.ts";
import { parseDuration } from "../../command-internal/duration.ts";
import { GLOBAL_OUTPUT_FORMATS, OutputFlag } from "../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../command-internal/hosted-consent/hosted-consent.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/output-formats.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { lazyManagementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { resolveProjectTarget } from "../../command-internal/target/resolve-project-target.ts";
import { projectTargetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  acceptanceOf,
  linkedReadInput,
  refOnlyStatusCommand,
  sendApiRequest,
  summaryText,
  waitForOperation,
  writeApiResponse,
  writeDryRun,
} from "./api-command-execute.ts";
import { type ApiFlagLocation, apiFlag } from "./api-command-flags.ts";
import { type ApiNoun, nouns } from "./api-command-policy.ts";
import { singleLine } from "./api-command.format.ts";
import {
  assembleInput,
  consentDetails,
  decodeInput,
  previewRequest,
  readBodyOverride,
} from "./api-command-request.ts";
import type {
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandWait,
  ApiPollRead,
} from "./api-command.model.ts";
import { apiCommands, apiPollTargets } from "./generated.ts";

const DEFAULT_WAIT_TIMEOUT = "10m";
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/** A command's `--wait`: the wait declared on its entry and the entry of the operation it polls. */
interface ResolvedWait {
  readonly wait: ApiCommandWait;
  readonly readEntry: ApiPollRead;
  readonly statusEntry: ApiCommandEntry;
}

const resolveWait = (entry: ApiCommandEntry): ResolvedWait | undefined => {
  const { wait } = entry;
  if (wait === undefined) return undefined;
  const publicRead = apiCommands.find((candidate) => candidate.operationId === wait.read);
  if (publicRead !== undefined) return { wait, readEntry: publicRead, statusEntry: publicRead };
  const hidden = apiPollTargets.find((candidate) => candidate.operationId === wait.read);
  const inspect = apiCommands.find((candidate) => candidate.operationId === hidden?.inspect);
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
              "Whole request body as JSON. Flags that set body fields override the matching fields.",
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
    Flag.withDescription("Print the request instead of sending it."),
    Flag.withDefault(false),
  ),
  ...(!waitable
    ? {}
    : {
        wait: Flag.Boolean("wait").pipe(
          Flag.withDescription("Wait until the operation reaches a final status."),
          Flag.withDefault(false),
        ),
        timeout: Flag.optional(
          Flag.String("timeout").pipe(
            Flag.withDescription(
              `How long --wait polls, as a duration such as 90s or 10m (default: ${DEFAULT_WAIT_TIMEOUT}).`,
            ),
          ),
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
        suggestion: "Use a duration such as 90s or 10m.",
      }),
  }).pipe(
    Effect.filterOrFail(
      (millis) => millis > 0,
      () =>
        new ApiCommandUsageError({
          message: `--timeout ${value} must be greater than zero.`,
          suggestion: "Use a duration such as 90s or 10m.",
        }),
    ),
  );

/**
 * Runs `use` under an output task, handing it the task's message updater; the task is cleared on
 * success and marked failed or cancelled otherwise.
 */
const withTask = <A, E, R>(
  message: string,
  use: (update: (message: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
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
  readonly timeout?: Option.Option<string>;
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
  const outputFlag = yield* OutputFlag;
  const format = output.format;
  yield* Effect.annotateCurrentSpan("output.presentation", format);
  yield* Effect.gen(function* () {
    if (Option.isSome(outputFlag)) {
      return yield* new ApiCommandUsageError({
        message: unsupportedOutputFlagMessage(entry.command.join(" ")),
      });
    }
    const waiting = resolved !== undefined && flags.wait === true;
    const timeout = flags.timeout ?? Option.none();
    if (!waiting && Option.isSome(timeout)) {
      return yield* new ApiCommandUsageError({
        message: "--timeout only applies with --wait.",
        suggestion: "Add --wait, or drop --timeout.",
      });
    }
    const timeoutMillis = waiting
      ? yield* parseTimeoutMillis(Option.getOrElse(timeout, () => DEFAULT_WAIT_TIMEOUT))
      : 0;
    const ref = yield* resolveProjectTarget(flags);
    yield* Effect.gen(function* () {
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
        yield* requireHostedMutationConsent({
          action: summaryText(entry),
          details: [
            ...(entry.confirmDescription && entry.description ? [entry.description] : []),
            ...consentDetails(entry, decoded),
          ],
        });
      }
      const api = yield* (yield* CommandPlatformApiFactory).make;
      const acceptance = acceptanceOf(
        entry,
        resolved === undefined ? undefined : refOnlyStatusCommand(resolved.statusEntry, ref),
      );

      if (waiting) {
        // A read that polls itself already returns the shape it prints; any other wait prints
        // the response the change was accepted with, once the polled operation has succeeded.
        const selfPolling = resolved.readEntry.operationId === entry.operationId;
        const accepted = selfPolling
          ? undefined
          : yield* withTask(summaryText(entry), () =>
              sendApiRequest(api, entry, decoded, { acceptance }),
            );
        const readInput =
          accepted === undefined
            ? input
            : yield* linkedReadInput({
                wait: resolved.wait,
                ref,
                changed: accepted,
                accepted: acceptance ?? { action: summaryText(entry) },
              });
        const polling = summaryText(resolved.readEntry);
        const settled = yield* withTask(polling, (update) =>
          waitForOperation({
            api,
            wait: resolved.wait,
            readEntry: resolved.readEntry,
            statusEntry: resolved.statusEntry,
            readInput,
            ref,
            timeoutMillis,
            accepted: acceptance,
            onPoll: (status) =>
              update(status === undefined ? polling : `${polling} (status: ${singleLine(status)})`),
          }),
        );
        yield* Effect.annotateCurrentSpan("run.outcome", "waited");
        return yield* writeApiResponse(accepted ?? settled, format, acceptance);
      }
      const response = yield* withTask(summaryText(entry), () =>
        sendApiRequest(api, entry, decoded, { acceptance }),
      );
      yield* Effect.annotateCurrentSpan("run.outcome", "sent");
      return yield* writeApiResponse(response, format, acceptance);
    }).pipe(Effect.ensuring(flags.dryRun ? Effect.void : cache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});

const exampleFor = (entry: ApiCommandEntry): string => {
  const required = entry.flags
    .filter((flag) => flag.required)
    .map((flag) => `--${flag.name}${flag.type === "boolean" ? "" : ` <${flag.name}>`}`);
  const positional = entry.argument === undefined ? [] : [`<${entry.argument.name}>`];
  const requiresBodyFlag = entry.bindings.some(
    (binding) =>
      binding.location === "body" &&
      binding.source === "flag" &&
      entry.flags.some((flag) => flag.required && flag.name === binding.flag),
  );
  const body = entry.body === undefined || requiresBodyFlag ? [] : ["--file <path>"];
  return ["supabase", ...entry.command, ...positional, ...required, ...body].join(" ");
};

// `--dry-run` returns before the API client exists, so the command, the poll and the cache lookup
// run only without it.
const sendsRequests = { flag: "dry-run", is: false } as const;

const permissionsOf = (entry: ApiCommandEntry, resolved: ResolvedWait | undefined) => {
  const polled = resolved?.readEntry.operationId;
  const operations: ReadonlyArray<OperationEntry> = [
    { operationId: entry.operationId, kind: "required", when: [sendsRequests] },
    ...(polled === undefined || polled === entry.operationId
      ? []
      : [
          {
            operationId: polled,
            kind: "required" as const,
            when: [sendsRequests, { flag: "wait", is: true }],
          },
        ]),
  ];
  const noApiEffectFlags = [
    ...(entry.body === undefined ? [] : ["body", "file"]),
    ...(resolved === undefined ? [] : ["timeout"]),
    ...(polled === entry.operationId ? ["wait"] : []),
    ...entry.flags.map((flag) => flag.name),
  ];
  return compose(
    { operations, noApiEffectFlags },
    projectRefPicker,
    withCondition(linkedProjectCache, sendsRequests),
    branchResolution,
  );
};

const leafOf = (entry: ApiCommandEntry) => {
  const verb = entry.command[entry.command.length - 1] ?? entry.operationId;
  const resolved = resolveWait(entry);
  const config = flagConfig(entry, resolved !== undefined);
  return Command.make(verb, config).pipe(
    Command.withDescription(entry.description ?? entry.summary),
    Command.withShortDescription(`${entry.summary} (experimental)`),
    Command.withExamples([
      { command: exampleFor(entry), description: entry.summary },
      ...(entry.examples ?? []),
    ]),
    withPermissions(permissionsOf(entry, resolved)),
    Command.withHandler((flags) => {
      const { api: _generated, argument: _argument, ...recorded } = flags;
      return handle(entry, resolved, flags).pipe(
        withCommandTelemetry({ flags: recorded, outputFormats: GLOBAL_OUTPUT_FORMATS }),
      );
    }),
    // `stdinLayer`: `--file -` reads the request body from piped stdin. `identityStitchLayer` is
    // shared by the lazy runtime and the post-run telemetry.
    Command.provide(
      Layer.mergeAll(
        lazyManagementApiRuntimeLayer(entry.command).pipe(Layer.provide(identityStitchLayer)),
        identityStitchLayer,
        stdinLayer,
      ),
    ),
    withTargetPolicy({ group: "hosted", consent: entry.readOnly ? "none" : "no" }),
  );
};

type ApiLeaf = ReturnType<typeof leafOf>;

/** A generated group: it fails and requires what its generated leaves do. */
type ApiGroup = Command.Command<string, {}, {}, Command.Error<ApiLeaf>, Command.Services<ApiLeaf>>;

const startsWith = (command: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.every((word, index) => command[index] === word);

const leafCache = new WeakMap<ApiCommandEntry, ApiLeaf>();

const cachedLeaf = (entry: ApiCommandEntry): ApiLeaf => {
  const cached = leafCache.get(entry);
  if (cached !== undefined) return cached;
  const leaf = leafOf(entry);
  leafCache.set(entry, leaf);
  return leaf;
};

const groupDescription = (path: ReadonlyArray<string>, noun: ApiNoun): string | undefined =>
  path.length === 1 ? noun.description : noun.groups?.[path.slice(1).join(".")];

/** The group at `path`, holding the generated commands below it. */
const groupAt = (path: ReadonlyArray<string>, noun: ApiNoun): ApiGroup => {
  const name = path[path.length - 1] ?? "";
  const under = apiCommands.filter((entry) => startsWith(entry.command, path));
  const childNames = new Set(
    under.flatMap((entry) =>
      entry.command.length > path.length + 1
        ? entry.command.slice(path.length, path.length + 1)
        : [],
    ),
  );
  const leaves = under
    .filter((entry) => entry.command.length === path.length + 1)
    .map((entry) => cachedLeaf(entry));
  const groups = [...childNames].map((child) => groupAt([...path, child], noun));
  const description = `${groupDescription(path, noun) ?? name} (experimental)`;
  return Command.make(name).pipe(
    Command.withDescription(description),
    Command.withShortDescription(description),
    Command.withSubcommands([...leaves, ...groups]),
  );
};

/**
 * `handWritten` with the generated Management API commands of every enabled noun added as a new
 * group, in alphabetical position.
 */
export const withApiCommands = <const C extends ReadonlyArray<Command.Command.Any>>(
  handWritten: C,
  enabledFeatures: ReadonlyArray<string>,
): ReadonlyArray<C[number] | ApiGroup> => {
  const merged: Array<C[number] | ApiGroup> = [...handWritten];
  for (const [name, noun] of Object.entries(nouns)) {
    if (!enabledFeatures.includes(noun.experimental)) continue;
    const position = merged.findIndex((command) => command.name > name);
    merged.splice(position < 0 ? merged.length : position, 0, groupAt([name], noun));
  }
  return merged;
};
