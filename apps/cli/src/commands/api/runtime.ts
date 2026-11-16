import { Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, type OperationEntry } from "../../command-internal/command-permissions/model.ts";
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
  sendApiRequest,
  waitForOperation,
  writeApiResponse,
  writeDocument,
} from "./api-command-execute.ts";
import { apiFlag } from "./api-command-flags.ts";
import {
  assembleInput,
  decodeInput,
  previewRequest,
  readBodyOverride,
} from "./api-command-request.ts";
import { type CommandStage, enforceStage, withCommandStage } from "./api-command-stage.ts";
import { withApiCommand } from "./api-command.annotation.ts";
import { ApiCommandUsageError } from "./api-command.errors.ts";
import type { ApiCommandEntry } from "./api-command.model.ts";
import { apiCommands } from "./generated.ts";
import { withStandardErrors } from "../../command-internal/command-errors/command-errors.annotation.ts";
import { nouns } from "./api-command-overrides.ts";

const DEFAULT_WAIT_TIMEOUT = "10m";
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const stageOf = (entry: ApiCommandEntry): CommandStage => ({
  status: "experimental",
  gate:
    entry.feature === undefined ? { kind: "flag" } : { kind: "feature", feature: entry.feature },
});

/** The flag config of a generated command: target flags, runtime flags and one flag per API field. */
const flagConfig = (entry: ApiCommandEntry) => ({
  ...projectTargetFlags(),
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
  ...(entry.wait === undefined
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
  api: Object.fromEntries(entry.flags.map((flag) => [flag.name, apiFlag(flag)])),
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
  flags: ApiCommandFlags,
) {
  yield* Effect.annotateCurrentSpan("operation.id", entry.operationId);
  const telemetryState = yield* TelemetryState;
  const cache = yield* LinkedProjectCache;
  const outputFlag = yield* OutputFlag;
  const format: ApiOutputFormat = Option.getOrUndefined(outputFlag) === "yaml" ? "yaml" : "json";
  yield* Effect.gen(function* () {
    yield* enforceStage(stageOf(entry));
    const ref = yield* resolveProjectTarget(flags);
    yield* Effect.gen(function* () {
      const timeoutMillis =
        entry.wait !== undefined && flags.wait === true
          ? yield* parseTimeoutMillis(flags.timeout ?? DEFAULT_WAIT_TIMEOUT)
          : 0;
      const override = yield* readBodyOverride({
        body: flags.body ?? Option.none(),
        file: flags.file ?? Option.none(),
      });
      const input = yield* assembleInput(entry, ref, flags.api, override);
      const decoded = yield* decodeInput(entry, input);

      if (flags.dryRun) {
        yield* Effect.annotateCurrentSpan("run.outcome", "dry_run");
        return yield* writeDocument(previewRequest(entry, decoded), format);
      }
      if (!entry.readOnly) {
        yield* requireHostedMutationConsent({ action: consentAction(entry) });
      }

      const response = yield* sendApiRequest(entry, decoded);
      if (entry.wait !== undefined && flags.wait === true) {
        const settled = yield* waitForOperation({
          wait: entry.wait,
          changedEntry: entry,
          ref,
          changed: response,
          timeoutMillis,
        });
        yield* Effect.annotateCurrentSpan(
          "run.outcome",
          settled.entry === entry ? "wait_skipped" : "waited",
        );
        return yield* writeApiResponse(settled.entry, settled.response, format);
      }
      yield* Effect.annotateCurrentSpan("run.outcome", "sent");
      return yield* writeApiResponse(entry, response, format);
    }).pipe(Effect.ensuring(cache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});

const exampleFor = (entry: ApiCommandEntry): string => {
  const required = entry.flags
    .filter((flag) => flag.required)
    .map((flag) => `--${flag.name}${flag.type === "boolean" ? "" : ` <${flag.name}>`}`);
  return ["supabase", ...entry.command, ...required].join(" ");
};

const permissionsOf = (entry: ApiCommandEntry) => {
  const operations: ReadonlyArray<OperationEntry> = [
    { operationId: entry.operationId, kind: "required" },
    ...(entry.wait === undefined
      ? []
      : [
          {
            operationId: entry.wait.read,
            kind: "required" as const,
            when: [{ flag: "wait", is: true }],
          },
        ]),
  ];
  const noApiEffectFlags = [
    "dry-run",
    ...(entry.body === undefined ? [] : ["body", "file"]),
    ...(entry.wait === undefined ? [] : ["timeout"]),
    ...entry.flags.map((flag) => flag.name),
  ];
  return compose(
    { operations, noApiEffectFlags },
    projectRefPicker,
    linkedProjectCache,
    branchResolution,
  );
};

const leafOf = (entry: ApiCommandEntry) => {
  const verb = entry.command[entry.command.length - 1] ?? entry.operationId;
  const config = flagConfig(entry);
  return Command.make(verb, config).pipe(
    Command.withDescription(entry.description ?? entry.summary),
    Command.withShortDescription(`${entry.summary} (experimental)`),
    Command.withExamples([{ command: exampleFor(entry), description: entry.summary }]),
    withApiCommand({
      operationId: entry.operationId,
      bindings: entry.bindings,
      response: entry.response,
    }),
    withPermissions(permissionsOf(entry)),
    withCommandStage(stageOf(entry)),
    withStandardErrors,
    Command.withHandler((flags) => {
      const { api: _generated, ...recorded } = flags;
      return handle(entry, flags).pipe(
        withCommandTelemetry({ flags: recorded, outputFormats: OUTPUT_FORMATS }),
      );
    }),
    // `stdinLayer`: `--file -` reads the request body from piped stdin.
    Command.provide(Layer.mergeAll(managementApiRuntimeLayer(entry.command), stdinLayer)),
    withTargetPolicy({ group: "hosted", consent: entry.readOnly ? "none" : "no" }),
  );
};

/** The command group of `noun`, with one leaf per entry whose command path sits under it. */
export const apiCommandGroup = (
  noun: string,
  description: string,
  entries: ReadonlyArray<ApiCommandEntry>,
) => {
  const leaves = entries
    .filter((entry) => entry.command.slice(0, -1).join(".") === noun)
    .map(leafOf);
  return Command.make(noun).pipe(
    Command.withDescription(`${description} (experimental)`),
    Command.withShortDescription(`${description} (experimental)`),
    Command.withSubcommands(leaves),
  );
};

const groupCache = new Map<string, ReturnType<typeof apiCommandGroup>>();

/**
 * The noun groups of the generated Management API commands, one per noun whose feature is
 * enabled (or that has no feature); a group is built on first use.
 */
export const apiCommandGroups = (enabledFeatures: ReadonlyArray<string>) =>
  Object.entries(nouns).flatMap(([noun, definition]) => {
    if (definition.feature !== undefined && !enabledFeatures.includes(definition.feature)) {
      return [];
    }
    const cached = groupCache.get(noun);
    if (cached !== undefined) return [cached];
    const group = apiCommandGroup(noun, definition.description, apiCommands);
    groupCache.set(noun, group);
    return [group];
  });
