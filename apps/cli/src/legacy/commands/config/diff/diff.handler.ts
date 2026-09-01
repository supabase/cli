import {
  CLI_CONFIG_SCHEMA_URL,
  fromApiProjectConfig,
  ProjectConfigParseError,
} from "@supabase/config";
import { diffProjectConfig, loadCliConfig } from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyResolveParentScopedProjectRef } from "../../../shared/legacy-parent-project-ref.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  legacyResolveBranchProjectRef,
} from "../../../shared/legacy-branch-ref.resolver.ts";
import {
  legacySanitizeInlineName,
  mapLegacyHttpError,
  sanitizeLegacyErrorBody,
} from "../../../shared/legacy-http-errors.ts";
import {
  legacyConfigDiffComparisonLine,
  legacyConfigDiffPayload,
  legacyConfigDiffScope,
  legacyConfigDiffScopeLine,
  legacyConfigDiffSummaryMessage,
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legacyConfigDiff = Effect.fn("legacy.config.diff")(function* (
  flags: LegacyConfigDiffFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const cliSettings = yield* LegacyCliSettings;
  const processControl = yield* ProcessControl;
  const goOutputFlag = yield* LegacyOutputFlag;

  // An empty `--project-ref` value is absent, mirroring the resolver's own rule.
  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);

  // Resolved against `cliSettings.workdir` — the same root the project-ref
  // resolver and the linked-project cache use — so `--workdir ../other`
  // compares `../other`'s config.toml against `../other`'s linked project,
  // never the invoking directory's file against another root's project.
  const loadLocalConfig = (projectRef: string | undefined) =>
    loadCliConfig(cliSettings.workdir, { projectRef, goViperCompat: true }).pipe(
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
      Effect.flatMap((loaded) =>
        loaded === null
          ? Effect.fail(
              new LegacyConfigDiffLoadConfigError({
                message:
                  "failed to read supabase/config.toml: file not found. Run `supabase init` to create one.",
              }),
            )
          : Effect.succeed(loaded),
      ),
    );

  // Written once the comparison target is known, so the linked-project cache
  // finalizer below only fires for invocations that got that far — matching
  // the family pattern of caching exactly the resolved ref.
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // 1. Load and validate the local config BEFORE any network call or
    // target resolution (never writes — this command is read-only by
    // contract): a missing file must point at `supabase init` rather than
    // the resolver's not-linked error, and a malformed document must not
    // burn a branch-resolution round trip. This first load applies no
    // `[remotes.*]` overlay — the overlay is keyed by the RESOLVED target
    // ref, so a config that declares remotes is reloaded in step 3.
    let loaded = yield* loadLocalConfig(undefined);

    // 2. Resolve the comparison target. `--project-ref` accepts a project
    // ref, or the name (or UUID) of a branch of the linked project —
    // `link`'s settled vocabulary (CLI-2167). A ref-shaped value (exactly 20
    // lowercase letters) is always treated as a project ref; a UUID resolves
    // through `GET /v1/branches/{id}` directly, so it works in an unlinked
    // directory (the parent ref is passed lazily and only evaluated for a
    // branch-NAME lookup). The parent comes from the PARENT-SCOPED resolver:
    // after `link <branch>`, `.temp/project-ref` holds the branch's own ref,
    // which the parent-scoped branches endpoint rejects — same rule as the
    // `branches` command family.
    let ref: string;
    let branch: string | undefined;
    if (Option.isSome(requested) && !LEGACY_BRANCH_PROJECT_REF_PATTERN.test(requested.value)) {
      const target = requested.value;
      branch = target;
      const resolving =
        output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
      ref = yield* legacyResolveBranchProjectRef(
        target,
        legacyResolveParentScopedProjectRef(Option.none()),
        {
          mapGetError: mapBranchResolveError,
          mapFindError: mapBranchResolveError,
        },
      ).pipe(
        Effect.tapError(() => resolving?.fail() ?? Effect.void),
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
      yield* resolving?.clear() ?? Effect.void;
    } else {
      ref = yield* resolver.resolve(requested);
    }
    resolvedRef = ref;

    // 3. Apply the matching `[remotes.*]` overlay (ADR 0018) now that the
    // target ref is known. Only configs that declare remotes reload — the
    // common remotes-free config keeps the step-1 load. A config that both
    // declares remotes and triggers a deprecation warning prints that
    // warning twice (once per load); the alternative is validating after the
    // network call, which is worse.
    if (isRecord(loaded.document?.["remotes"])) {
      loaded = yield* loadLocalConfig(ref);
    }

    const context: LegacyConfigDiffContext = {
      projectRef: ref,
      branch,
      appliedRemote: loaded.appliedRemote,
      configSchema: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    };
    yield* output.raw(legacyConfigDiffComparisonLine(context), "stderr");

    // 4. Fetch the effective remote config (single read-only call) — via
    // `executeRaw`, per ADR 0019 rule 2 ("required, not incidental"): the
    // generated client's strict Schema.Struct decode drops excess properties
    // and rejects unknown enum members (e.g. a new `pool_mode` value), so
    // by the time the lenient config mirror ran on its output there would be
    // nothing left to be lenient about. The caller owns the status check;
    // `fromApiProjectConfig`'s lenient decode owns the body.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching remote config...") : undefined;
    const response = yield* api.executeRaw(operationDefinitions.v2GetProjectConfig, { ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new LegacyConfigDiffReadNetworkError({
            message: `failed to read project config: ${cause}`,
          }),
      ),
    );
    if (response.status !== 200) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyConfigDiffReadStatusError({
        status: response.status,
        body,
        message: readStatusMessage(response.status, body),
      });
    }
    const responseJson = yield* response.json.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new LegacyConfigDiffReadNetworkError({
            message: `failed to read project config: ${cause}`,
            decode: true,
          }),
      ),
    );
    yield* fetching?.clear() ?? Effect.void;

    // 5. Project the response through CLI-2230's convergence normalizer (ADR
    // 0021). A response the registry cannot narrow (out-of-domain mapped
    // values) is a response problem, not a transport one:
    // `ProjectConfigParseError` stays in the typed channel with its own
    // `suggestion` and its purpose-built actionability adapter
    // (`externalActionabilityByTag` splits caller misuse from genuine
    // response problems). Anything else escaping the normalizer would be a
    // bug in this package pairing, so it stays a defect.
    const remote = yield* Effect.try({
      try: () => fromApiProjectConfig(responseJson),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof ProjectConfigParseError ? Effect.fail(cause) : Effect.die(cause),
      ),
    );

    // 6. Classify. The loaded pair carries the raw merged document (declared
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

    const data = isRecord(responseJson) ? responseJson["data"] : undefined;
    const scope = legacyConfigDiffScope(
      isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {},
    );
    yield* output.raw(legacyConfigDiffScopeLine(scope), "stderr");

    // 7. Emit. Both output mechanisms are honored, `--output` first (Legacy
    // Shell Invariant #6): the machine formats encode the same structured
    // payload the `--output-format json` envelope carries; `pretty` (and
    // unset) falls through to `--output-format` handling. stdout stays
    // payload-pure in every machine mode — diagnostics above went to stderr,
    // and root.ts swaps in the quiet-progress layer for `-o` machine formats
    // (CLI-1546).
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
      yield* output.success(
        legacyConfigDiffSummaryMessage(changeSet),
        legacyConfigDiffPayload(changeSet, scope, context),
      );
    } else {
      yield* output.raw(legacyRenderConfigDiffText(changeSet));
    }

    // 8. `--exit-code`: differences flip the exit status to 2 after the
    // payload is out, without an error envelope corrupting machine output.
    // Drift gets its OWN code — every failure exits 1, and a script's
    // `config diff --exit-code || alert` must not fire on an expired token
    // (`terraform plan -detailed-exitcode`'s 0/1/2 convention, with 1 kept
    // for errors to match the rest of the CLI).
    if (flags.exitCode && changeSet.counts.total > 0) {
      yield* processControl.setExitCode(2);
    }
  }).pipe(
    // Legacy Shell Invariant #1: telemetry flushes on EVERY invocation —
    // including load/parse failures and branch-resolution failures — while
    // the linked-project cache write needs a resolved ref, so it fires
    // exactly when one exists.
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
