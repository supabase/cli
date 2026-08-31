import {
  CLI_CONFIG_SCHEMA_URL,
  diffProjectConfig,
  fromApiProjectConfig,
  ProjectConfigParseError,
} from "@supabase/config";
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
  legacyConfigDiffPayload,
  legacyConfigDiffScope,
  legacyConfigDiffScopeLine,
  legacyRenderConfigDiffText,
  type LegacyConfigDiffContext,
} from "./diff.format.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import {
  LegacyConfigDiffBranchNotFoundError,
  LegacyConfigDiffBranchResolveNetworkError,
  LegacyConfigDiffBranchResolveStatusError,
  LegacyConfigDiffFlagConflictError,
  LegacyConfigDiffLoadConfigError,
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

    // 3. Project the response through CLI-2230's convergence normalizer (ADR
    // 0021). A response the registry cannot narrow (out-of-domain mapped
    // values) is a response problem, not a transport one:
    // `ProjectConfigParseError` stays in the typed channel with its own
    // `suggestion` and its purpose-built actionability adapter
    // (`externalActionabilityByTag` splits caller misuse from genuine
    // response problems). Anything else escaping the normalizer would be a
    // bug in this package pairing, so it stays a defect.
    const remote = yield* Effect.try({
      try: () => fromApiProjectConfig(response),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
      ),
    );

    // 4. Classify. The loaded pair carries the raw merged document (declared
    // keys) and the env-var origins; `diffProjectConfig` derives the local
    // convergence projection from it, so the same `ProjectConfigParseError`
    // boundary applies here.
    const changeSet = yield* Effect.try({
      try: () => diffProjectConfig({ local: loaded, remote }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
      ),
    );

    const scope = legacyConfigDiffScope(response.data.attributes);
    yield* output.raw(legacyConfigDiffScopeLine(scope), "stderr");

    // 5. Emit: `--output-format json|stream-json` structured payload, or text.
    // Both output mechanisms are honored, `--output` first (Legacy Shell
    // Invariant #6): the machine formats encode the same structured payload
    // the `--output-format json` envelope carries; `pretty` (and unset) falls
    // through to `--output-format` handling. stdout stays payload-pure in
    // every machine mode — diagnostics above went to stderr, and root.ts
    // swaps in the quiet-progress layer for `-o` machine formats (CLI-1546).
    const goFmt = Option.getOrUndefined(goOutputFlag);
    if (goFmt !== undefined && goFmt !== "pretty") {
      const payload = legacyConfigDiffPayload(changeSet, scope, context);
      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(payload));
      } else if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(payload));
      } else if (goFmt === "toml") {
        yield* output.raw(encodeToml(payload));
      } else {
        yield* output.raw(encodeEnv(payload) + "\n");
      }
    } else if (output.format !== "text") {
      const total = changeSet.counts.total;
      const message =
        total === 0 ? "No config differences found." : `${total} config difference(s) found.`;
      yield* output.success(message, legacyConfigDiffPayload(changeSet, scope, context));
    } else {
      yield* output.raw(legacyRenderConfigDiffText(changeSet));
    }

    // 6. `--exit-code`: differences flip the exit status after the payload is
    // out, without an error envelope corrupting machine output.
    if (flags.exitCode && changeSet.counts.total > 0) {
      yield* processControl.setExitCode(1);
    }
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
