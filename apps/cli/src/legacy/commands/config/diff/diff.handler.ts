import { diffProjectConfig, CLI_CONFIG_SCHEMA_URL } from "@supabase/config";
import { loadCliConfig } from "@supabase/config/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  legacyResolveBranchProjectRef,
} from "../../../shared/legacy-branch-ref.resolver.ts";
import {
  legacySanitizeInlineName,
  mapLegacyHttpError,
} from "../../../shared/legacy-http-errors.ts";
import {
  legacyConfigDiffComparisonLine,
  legacyConfigDiffEnvReferences,
  legacyConfigDiffPayload,
  legacyConfigDiffRemoteBlocks,
  legacyConfigDiffScopeLine,
  legacyRenderConfigDiffText,
  type LegacyConfigDiffContext,
} from "./diff.format.ts";
import {
  LegacyConfigDiffBranchNotFoundError,
  LegacyConfigDiffBranchResolveNetworkError,
  LegacyConfigDiffBranchResolveStatusError,
  LegacyConfigDiffFlagConflictError,
  LegacyConfigDiffLoadConfigError,
  LegacyConfigDiffOutputFlagUnsupportedError,
  LegacyConfigDiffReadNetworkError,
  LegacyConfigDiffReadStatusError,
} from "./diff.errors.ts";
import type { LegacyConfigDiffFlags } from "./diff.command.ts";

const readStatusMessage = (status: number, body: string) => `unexpected status ${status}: ${body}`;

const mapBranchResolveError = mapLegacyHttpError({
  networkError: LegacyConfigDiffBranchResolveNetworkError,
  statusError: LegacyConfigDiffBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: readStatusMessage,
});

export const legacyConfigDiff = Effect.fn("legacy.config.diff")(function* (
  flags: LegacyConfigDiffFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const processControl = yield* ProcessControl;
  const goOutputFlag = yield* LegacyOutputFlag;

  // Net-new TS command with no Go parity contract: the Go-compat `-o/--output`
  // flag is rejected outright (every value, `pretty` included) rather than
  // honored — machine output goes through `--output-format` only (CLI-2156,
  // per Colum). Checked first so no target resolution or network call runs.
  if (Option.isSome(goOutputFlag)) {
    return yield* new LegacyConfigDiffOutputFlagUnsupportedError({
      message:
        "the -o/--output flag is not supported by config diff; use --output-format json|stream-json instead.",
    });
  }

  if (Option.isSome(flags.target) && Option.isSome(flags.projectRef)) {
    return yield* new LegacyConfigDiffFlagConflictError({
      message: "--target and --project-ref are mutually exclusive; pass at most one.",
    });
  }

  // Resolve the comparison target to a project ref. `--target` accepts a
  // branch name, a branch UUID, or a raw project ref (same acceptance as
  // `link`); a ref-shaped value skips the parent-project resolution entirely
  // so it works in an unlinked directory.
  let ref: string;
  let branch: string | undefined;
  if (Option.isSome(flags.target) && !LEGACY_BRANCH_PROJECT_REF_PATTERN.test(flags.target.value)) {
    const target = flags.target.value;
    branch = target;
    const parentRef = yield* resolver.resolve(Option.none());
    ref = yield* legacyResolveBranchProjectRef(target, parentRef, {
      mapGetError: mapBranchResolveError,
      mapFindError: mapBranchResolveError,
    }).pipe(
      Effect.catchTag(
        "LegacyConfigDiffBranchResolveStatusError",
        (
          cause,
        ): Effect.Effect<
          never,
          LegacyConfigDiffBranchNotFoundError | LegacyConfigDiffBranchResolveStatusError
        > =>
          cause.status === 404
            ? Effect.fail(
                new LegacyConfigDiffBranchNotFoundError({
                  message: `Branch "${legacySanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.`,
                }),
              )
            : Effect.fail(cause),
      ),
    );
  } else if (Option.isSome(flags.target)) {
    ref = flags.target.value;
  } else {
    ref = yield* resolver.resolve(flags.projectRef);
  }

  yield* Effect.gen(function* () {
    // 1. Load the local config, merging a matching `[remotes.*]` block over
    // the base document when the target ref names a declared branch (ADR
    // 0018). Never writes — this command is read-only by contract.
    const loaded = yield* loadCliConfig(runtimeInfo.cwd, {
      projectRef: ref,
      goViperCompat: true,
    }).pipe(
      Effect.catchTag(
        "CliConfigParseError",
        (cause) =>
          new LegacyConfigDiffLoadConfigError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
      Effect.catchTag(
        "DuplicateRemoteProjectIdError",
        (cause) => new LegacyConfigDiffLoadConfigError({ message: cause.message }),
      ),
    );
    if (loaded === null) {
      return yield* new LegacyConfigDiffLoadConfigError({
        message:
          "failed to read supabase/config.toml: file not found. Run `supabase init` to create one.",
      });
    }

    const context: LegacyConfigDiffContext = {
      projectRef: ref,
      branch,
      appliedRemote: loaded.appliedRemote,
      schemaVersion: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    };
    yield* output.raw(legacyConfigDiffComparisonLine(context), "stderr");

    // 2. Fetch the effective remote config (single read-only call).
    const fetching =
      output.format === "text" ? yield* output.task("Fetching remote config...") : undefined;
    const response = yield* api.v2.getProjectConfig({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(
        mapLegacyHttpError({
          networkError: LegacyConfigDiffReadNetworkError,
          statusError: LegacyConfigDiffReadStatusError,
          networkMessage: (cause) => `failed to read project config: ${cause}`,
          statusMessage: readStatusMessage,
        }),
      ),
    );
    yield* fetching?.clear() ?? Effect.void;

    // 3. Classify. `declared` is the raw merged document (key presence);
    // `local` is the decoded effective config; env-resolved leaves carry the
    // resolving variable's name for the output.
    const changeSet = diffProjectConfig({
      local: loaded.config,
      declared: loaded.document,
      remote: legacyConfigDiffRemoteBlocks(response.data.attributes),
      envReferences: legacyConfigDiffEnvReferences(loaded.valueOrigins),
    });

    yield* output.raw(legacyConfigDiffScopeLine(changeSet.scope), "stderr");

    // 4. Emit: `--output-format json|stream-json` structured payload, or text.
    if (output.format !== "text") {
      const total = changeSet.changes.length;
      const message =
        total === 0 ? "No config differences found." : `${total} config difference(s) found.`;
      yield* output.success(message, legacyConfigDiffPayload(changeSet, context));
    } else {
      yield* output.raw(legacyRenderConfigDiffText(changeSet));
    }

    // 5. `--exit-code`: differences flip the exit status after the payload is
    // out, without an error envelope corrupting machine output.
    if (flags.exitCode && changeSet.changes.length > 0) {
      yield* processControl.setExitCode(1);
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
