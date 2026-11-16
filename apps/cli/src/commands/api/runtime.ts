import { Effect, Layer, Option } from "effect";
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
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
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
  writeDocument,
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
import type { ApiCommandEntry, ApiCommandFlag, ApiCommandWait } from "./api-command.model.ts";
import { apiCommands } from "./generated.ts";

const DEFAULT_WAIT_TIMEOUT = "10m";
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const stageOf = (entry: ApiCommandEntry): CommandStage => ({
  status: "experimental",
  feature: entry.feature,
});

/** A command's `--wait`: the wait declared on its entry and the entry of the operation it polls. */
interface ResolvedWait {
  readonly wait: ApiCommandWait;
  readonly readEntry: ApiCommandEntry;
}

const resolveWait = (
  entry: ApiCommandEntry,
  entries: ReadonlyArray<ApiCommandEntry>,
): ResolvedWait | undefined => {
  const { wait } = entry;
  if (wait === undefined) return undefined;
  const readEntry = entries.find((candidate) => candidate.operationId === wait.read);
  return readEntry === undefined ? undefined : { wait, readEntry };
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

const consentAction = (entry: ApiCommandEntry): string => entry.summary.replace(/\.$/, "");

const OUTPUT_FORMATS: ReadonlyArray<ApiOutputFormat> = ["json", "yaml"];

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
  const outputFlag = yield* OutputFlag;
  const format: ApiOutputFormat = Option.getOrUndefined(outputFlag) === "yaml" ? "yaml" : "json";
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
        return yield* writeDocument(previewRequest(entry, decoded), format);
      }
      if (!entry.readOnly) {
        yield* requireHostedMutationConsent({ action: consentAction(entry) });
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
              changed: yield* sendApiRequest(entry, decoded),
            });
        const settled = yield* waitForOperation({
          wait: resolved.wait,
          readEntry: resolved.readEntry,
          readInput,
          ref,
          timeoutMillis,
        });
        yield* Effect.annotateCurrentSpan("run.outcome", "waited");
        return yield* writeApiResponse(resolved.readEntry, settled, format);
      }
      const response = yield* sendApiRequest(entry, decoded);
      yield* Effect.annotateCurrentSpan("run.outcome", "sent");
      return yield* writeApiResponse(entry, response, format);
    }).pipe(Effect.ensuring(cache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});

const exampleFor = (entry: ApiCommandEntry): string => {
  const required = entry.flags
    .filter((flag) => flag.required)
    .map((flag) => `--${flag.name}${flag.type === "boolean" ? "" : ` <${flag.name}>`}`);
  const positional = entry.argument === undefined ? [] : [`<${entry.argument.name}>`];
  return ["supabase", ...entry.command, ...positional, ...required].join(" ");
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
type ApiGroup = Command.Command<string, {}, {}, Command.Error<ApiLeaf>, Command.Services<ApiLeaf>>;

const startsWith = (command: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.every((word, index) => command[index] === word);

const groupOf = (
  path: ReadonlyArray<string>,
  description: string,
  definition: ApiNoun,
  entries: ReadonlyArray<ApiCommandEntry>,
): ApiGroup => {
  const under = entries.filter((entry) => startsWith(entry.command, path));
  const leaves = under
    .filter((entry) => entry.command.length === path.length + 1)
    .map((entry) => leafOf(entry, entries));
  const children = Object.entries(definition.groups ?? {}).flatMap(([key, childDescription]) => {
    const childPath = [...path.slice(0, 1), ...key.split(".")];
    const isChild = childPath.length === path.length + 1 && startsWith(childPath, path);
    const hasCommands = under.some((entry) => startsWith(entry.command, childPath));
    return isChild && hasCommands
      ? [groupOf(childPath, childDescription, definition, entries)]
      : [];
  });
  return Command.make(path[path.length - 1] ?? "").pipe(
    Command.withDescription(`${description} (experimental)`),
    Command.withShortDescription(`${description} (experimental)`),
    Command.withSubcommands([...leaves, ...children]),
  );
};

/** The command group of `noun`, with its sub-groups and one leaf per entry whose command sits under it. */
export const apiCommandGroup = (
  noun: string,
  definition: ApiNoun,
  entries: ReadonlyArray<ApiCommandEntry>,
) => groupOf([noun], definition.description, definition, entries);

const groupCache = new Map<string, ReturnType<typeof apiCommandGroup>>();

/**
 * The noun groups of the generated Management API commands, one per noun whose feature is
 * enabled; a group is built on first use.
 */
export const apiCommandGroups = (enabledFeatures: ReadonlyArray<string>) =>
  Object.entries(nouns).flatMap(([noun, definition]) => {
    if (!enabledFeatures.includes(definition.feature)) return [];
    const cached = groupCache.get(noun);
    if (cached !== undefined) return [cached];
    const group = apiCommandGroup(noun, definition, apiCommands);
    groupCache.set(noun, group);
    return [group];
  });
