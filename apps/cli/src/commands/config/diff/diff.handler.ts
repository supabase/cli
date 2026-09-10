import {
  CLI_CONFIG_SCHEMA_URL,
  diffProjectConfig,
  fromApiProjectConfig,
} from "@supabase/config/effect";
import { remoteNameForProjectRef } from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/go-output-flag.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import {
  mapHttpError,
  sanitizeErrorBody,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import {
  configTargetErrorsFor,
  resolveConfigTarget,
} from "../../../command-internal/project-target.ts";
import { configIsRecord } from "../config.paths.ts";
import { loadLocalConfig } from "../config.load.ts";
import { configApiScope, configScopeLine } from "../config.format.ts";
import { configProjectConfigTry } from "../config.project-config.ts";
import { configReadStatusMessage } from "../config.read-status.ts";
import {
  configDiffComparisonLine,
  configDiffPayload,
  configDiffSummaryMessage,
  renderConfigDiffText,
  type ConfigDiffContext,
} from "./diff.format.ts";
import {
  ConfigDiffBranchNotFoundError,
  ConfigDiffBranchNotLinkedError,
  ConfigDiffBranchNotReadyError,
  ConfigDiffBranchResolveNetworkError,
  ConfigDiffBranchResolveStatusError,
  ConfigDiffLoadConfigError,
  ConfigDiffOutputFlagUnsupportedError,
  ConfigDiffParentRefInvalidError,
  ConfigDiffReadNetworkError,
  ConfigDiffReadStatusError,
  ConfigDiffWorkdirError,
} from "./diff.errors.ts";
import type { ConfigDiffFlags } from "./diff.command.ts";

const mapBranchResolveError = mapHttpError({
  networkError: ConfigDiffBranchResolveNetworkError,
  statusError: ConfigDiffBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});

// Maps resolveConfigTarget's generic errors onto config diff's own tagged error classes.
const configTargetErrors = configTargetErrorsFor({
  notLinked: ConfigDiffBranchNotLinkedError,
  parentRefInvalid: ConfigDiffParentRefInvalidError,
  branchNotFound: ConfigDiffBranchNotFoundError,
  branchNotReady: ConfigDiffBranchNotReadyError,
});

export const configDiff = Effect.fn("config.diff")(function* (flags: ConfigDiffFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  const processControl = yield* ProcessControl;
  const goOutputFlag = yield* OutputFlag;
  const fs = yield* FileSystem.FileSystem;

  // An empty `--project-ref` value is absent, mirroring the resolver's own rule.
  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);

  // Resolved against `cliSettings.workdir`, the same root the project-ref resolver and the
  // linked-project cache use, so `--workdir ../other` compares that directory's own config
  // against its own linked project.
  const loadConfig = (projectRef: string | undefined) =>
    loadLocalConfig(
      cliSettings,
      projectRef,
      (message) => new ConfigDiffLoadConfigError({ message }),
    );

  // Set once the target ref resolves, so the Effect.ensuring cache write below only fires for
  // invocations that got that far.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // Reject `-o/--output` outright: this command only supports `--output-format`. Checked first
    // so an invalid invocation never burns a config load or a network call.
    if (Option.isSome(goOutputFlag)) {
      return yield* new ConfigDiffOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("config diff"),
      });
    }

    // Validated before the config load so a missing workdir surfaces its own chdir error
    // rather than the generic "no supabase/ project" one.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigDiffWorkdirError({ message: error.message })),
    );

    // Loaded before target resolution so a missing config points at `supabase init` rather than
    // a not-linked error, and a malformed document doesn't burn a branch-resolution round trip.
    // No `[remotes.*]` overlay yet -- it's keyed by the resolved ref, applied below.
    let loaded = yield* loadConfig(undefined);

    // See resolveConfigTarget's doc comment for the target-resolution rules this preserves.
    const { ref, branch } = yield* resolveConfigTarget(
      requested,
      configTargetErrors,
      mapBranchResolveError,
    );
    resolvedRef = ref;

    // Reload only if a `[remotes.*]` entry matches the resolved ref (ADR 0018), matched against
    // the raw pre-`env()` `project_id` literal so an `env(REF)` entry that merely resolves to
    // `ref` isn't treated as a match -- that would reload the config and duplicate its load-time
    // warnings.
    const remoteMatchesRef =
      remoteNameForProjectRef(loaded.rawDocument?.["remotes"], ref) !== undefined;
    if (remoteMatchesRef) {
      loaded = yield* loadConfig(ref);
    }

    const context: ConfigDiffContext = {
      projectRef: ref,
      branch,
      appliedRemote: loaded.appliedRemote,
      configSchema: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    };
    yield* output.raw(configDiffComparisonLine(context), "stderr");

    // Uses executeRaw (ADR 0019) rather than the generated client: its strict schema decode would
    // drop excess properties and reject unknown enum values before the lenient decode below
    // could see them.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching remote config...") : undefined;
    const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new ConfigDiffReadNetworkError({
            message: `failed to read project config: ${cause}`,
          }),
      ),
    );
    if (response.status !== 200) {
      const body = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
      yield* fetching?.fail() ?? Effect.void;
      return yield* new ConfigDiffReadStatusError({
        status: response.status,
        body,
        message: configReadStatusMessage(response.status, body, ref, cliSettings.apiUrl),
      });
    }
    const responseJson = yield* response.json.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new ConfigDiffReadNetworkError({
            message: `failed to read project config: ${cause}`,
            decode: true,
          }),
      ),
    );
    yield* fetching?.clear() ?? Effect.void;

    // configProjectConfigTry (ADR 0021) keeps a response the schema can't narrow as a typed
    // ProjectConfigParseError; anything else escaping it is a defect.
    const remote = yield* configProjectConfigTry(() => fromApiProjectConfig(responseJson));

    // diffProjectConfig derives the local convergence projection from the loaded document, so
    // the same ProjectConfigParseError boundary applies here.
    const changeSet = yield* configProjectConfigTry(() =>
      diffProjectConfig({ local: loaded, remote }),
    );

    const data = configIsRecord(responseJson) ? responseJson["data"] : undefined;
    const scope = configApiScope(
      configIsRecord(data) && configIsRecord(data["attributes"]) ? data["attributes"] : {},
    );
    yield* output.raw(configScopeLine(scope), "stderr");

    // `-o/--output` never reaches here (rejected above), so `--output-format` is the only
    // machine-output path.
    if (output.format !== "text") {
      yield* output.success(
        configDiffSummaryMessage(changeSet, scope),
        configDiffPayload(changeSet, scope, context),
      );
    } else {
      yield* output.raw(renderConfigDiffText(changeSet, scope));
    }

    // `--exit-code` sets exit 2 for drift, distinct from the 1 every other failure uses, so a
    // script's `config diff --exit-code || alert` doesn't fire on an expired token. Text mode
    // prints a stderr reason line first so a CI log isn't just "exit code 2".
    if (flags.exitCode && changeSet.counts.total > 0) {
      if (output.format === "text") {
        yield* output.raw("Exiting 2: configuration differences found (--exit-code).\n", "stderr");
      }
      yield* processControl.setExitCode(2);
    }
  }).pipe(
    // Telemetry flushes on every invocation; the linked-project cache write only fires once a
    // ref has resolved.
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
