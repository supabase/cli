import {
  CLI_CONFIG_SCHEMA_URL,
  diffProjectConfig,
  fromApiProjectConfig,
  ProjectConfigParseError,
} from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import {
  legacyParentNotLinkedMessage,
  legacyParentRefInvalidMessage,
  legacyParentRefTypoHint,
  legacyResolveLinkedParentRef,
  legacyResolveParentScopedProjectRef,
} from "../../../shared/legacy-parent-project-ref.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { legacyResolveBranchProjectRef } from "../../../shared/legacy-branch-ref.resolver.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  LEGACY_BRANCH_UUID_PATTERN,
} from "../../../shared/legacy-ref-patterns.ts";
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
  LegacyConfigDiffBranchNotFoundError,
  LegacyConfigDiffBranchNotLinkedError,
  LegacyConfigDiffBranchNotReadyError,
  LegacyConfigDiffBranchResolveNetworkError,
  LegacyConfigDiffBranchResolveStatusError,
  LegacyConfigDiffLoadConfigError,
  LegacyConfigDiffOutputFlagUnsupportedError,
  LegacyConfigDiffParentRefInvalidError,
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

/**
 * Purpose-written messages for the config-read status codes a wrong or
 * inaccessible ref most plausibly produces; every other status keeps the
 * generic `unexpected status N: body` shape. TS-only surface (no Go
 * counterpart for this endpoint).
 */
function configReadStatusMessage(status: number, body: string, ref: string): string {
  if (status === 401) {
    return "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.";
  }
  if (status === 403) {
    return `Access denied for project ${legacySanitizeInlineName(ref)}: your account does not have permission to view its configuration.`;
  }
  if (status === 404) {
    return `Project ${legacySanitizeInlineName(ref)} not found. Check the project ref, or run \`supabase projects list\` to see the projects you have access to.`;
  }
  return readStatusMessage(status, body);
}

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
  // `cause.path` is anchored under the workdir; render it relative so the
  // message reads `supabase/config.json` like the family's other messages,
  // regardless of invocation cwd.
  const relativeConfigPath = (path: string) =>
    path.startsWith(cliSettings.workdir)
      ? path.slice(cliSettings.workdir.length).replace(/^[/\\]/, "")
      : path;

  const loadLocalConfig = (projectRef: string | undefined) =>
    loadCliConfig(cliSettings.workdir, { projectRef, goViperCompat: true }).pipe(
      // `cause.path` names the file that actually failed to parse — `loadCliConfig`
      // probes `supabase/config.json` before falling back to `supabase/config.toml`
      // (`findCliProjectPaths`), so hardcoding the `.toml` name here would mislabel a
      // broken `config.json`.
      Effect.catchTag(
        "CliConfigParseError",
        (cause) =>
          new LegacyConfigDiffLoadConfigError({
            message: `failed to parse ${relativeConfigPath(cause.path)}: ${String(cause.cause)}`,
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
                  "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
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
    // 1. Reject the Go-compat `-o/--output` flag outright, before anything
    // else this block does. `config diff` is a net-new TS command with no
    // Go parity contract, so machine output goes through `--output-format`
    // only (every value, `pretty` included — CLI-2156, per Colum). Checked
    // first, ahead of the config load below, so an invalid invocation never
    // burns a config read or a network call; still inside this
    // `Effect.ensuring`-wrapped block, so telemetry flushes on the rejection
    // the same as every other failure here.
    if (Option.isSome(goOutputFlag)) {
      return yield* new LegacyConfigDiffOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by config diff; use --output-format json|stream-json instead.",
      });
    }

    // 2. Load and validate the local config BEFORE any network call or
    // target resolution (never writes — this command is read-only by
    // contract): a missing file must point at `supabase init` rather than
    // the resolver's not-linked error, and a malformed document must not
    // burn a branch-resolution round trip. This first load applies no
    // `[remotes.*]` overlay — the overlay is keyed by the RESOLVED target
    // ref, so a config that declares remotes is reloaded in step 4.
    let loaded = yield* loadLocalConfig(undefined);

    // 3. Resolve the comparison target. `--project-ref` accepts a project
    // ref, or the name (or UUID) of a branch of the linked project —
    // `link`'s settled vocabulary (CLI-2167). A ref-shaped value (exactly 20
    // lowercase letters) is always treated as a project ref.
    //
    // A UUID target resolves through `GET /v1/branches/{id}` directly, which
    // needs no parent ref at all, so it keeps the fully lazy parent
    // resolution below — the parent-scoped resolver is never evaluated for
    // it, which is exactly what lets it work in an unlinked directory.
    //
    // A NAME target, by contrast, needs the parent project ref to search
    // under, so it is resolved eagerly, BEFORE any spinner starts —
    // mirroring `link` (link.handler.ts:198-213): an unlinked directory (or
    // a corrupt/stale linked ref) must fail immediately with a link-grade
    // error naming the value the user passed, rather than falling through to
    // `resolver.resolve`'s interactive project picker rendering under a live
    // "Resolving branch..." spinner.
    let ref: string;
    let branch: string | undefined;
    if (Option.isSome(requested) && !LEGACY_BRANCH_PROJECT_REF_PATTERN.test(requested.value)) {
      const target = requested.value;
      branch = target;

      let parentRef: ReturnType<typeof legacyResolveParentScopedProjectRef>;
      if (LEGACY_BRANCH_UUID_PATTERN.test(target)) {
        parentRef = legacyResolveParentScopedProjectRef(Option.none());
      } else {
        const parent = yield* legacyResolveLinkedParentRef();
        if (parent.kind === "absent") {
          return yield* new LegacyConfigDiffBranchNotLinkedError({
            message: legacyParentNotLinkedMessage(target),
          });
        }
        if (parent.kind === "invalid") {
          return yield* new LegacyConfigDiffParentRefInvalidError({
            message: legacyParentRefInvalidMessage(target),
          });
        }
        parentRef = Effect.succeed(parent.ref);
      }

      const resolving =
        output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
      ref = yield* legacyResolveBranchProjectRef(target, parentRef, {
        mapGetError: mapBranchResolveError,
        mapFindError: mapBranchResolveError,
      }).pipe(
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
                    message: `Branch "${legacySanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.${legacyParentRefTypoHint(target)}`,
                  }),
                )
              : Effect.fail(cause),
        ),
      );
      yield* resolving?.clear() ?? Effect.void;

      // The resolved branch might not have a project ref yet (still
      // provisioning) — never let an empty/placeholder ref reach
      // `/v2/projects//config` (mirrors link.handler.ts:248-256's guard).
      if (!LEGACY_BRANCH_PROJECT_REF_PATTERN.test(ref)) {
        return yield* new LegacyConfigDiffBranchNotReadyError({
          message: `Branch "${legacySanitizeInlineName(target)}" has no project ref yet. Wait for it to finish provisioning, then retry.`,
        });
      }
    } else {
      ref = yield* resolver.resolve(requested);
    }
    resolvedRef = ref;

    // 4. Apply the matching `[remotes.*]` overlay (ADR 0018) now that the
    // target ref is known. Only a config whose remotes actually MATCH the
    // resolved ref reloads (checked on the already-loaded, env-interpolated
    // document) — every other config keeps the step-2 load, so load-time
    // deprecation warnings don't repeat. The narrow remaining double-print
    // (a matching remote AND a deprecated section) is the price of
    // validating before the network call, which is worse to give up.
    const remotes = loaded.document?.["remotes"];
    const remoteMatchesRef =
      isRecord(remotes) &&
      Object.values(remotes).some((remote) => isRecord(remote) && remote["project_id"] === ref);
    if (remoteMatchesRef) {
      loaded = yield* loadLocalConfig(ref);
    }

    const context: LegacyConfigDiffContext = {
      projectRef: ref,
      branch,
      appliedRemote: loaded.appliedRemote,
      configSchema: loaded.schemaRef ?? CLI_CONFIG_SCHEMA_URL,
    };
    yield* output.raw(legacyConfigDiffComparisonLine(context), "stderr");

    // 5. Fetch the effective remote config (single read-only call) — via
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
        message: configReadStatusMessage(response.status, body, ref),
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

    // 6. Project the response through CLI-2230's convergence normalizer (ADR
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

    // 7. Classify. The loaded pair carries the raw merged document (declared
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

    // 8. Emit: `--output-format json|stream-json` structured payload, or
    // text. `-o/--output` never reaches here — step 1 rejects it outright,
    // so this command has only the one machine-output mechanism.
    if (output.format !== "text") {
      yield* output.success(
        legacyConfigDiffSummaryMessage(changeSet, scope),
        legacyConfigDiffPayload(changeSet, scope, context),
      );
    } else {
      yield* output.raw(legacyRenderConfigDiffText(changeSet, scope));
    }

    // 9. `--exit-code`: differences flip the exit status to 2 after the
    // payload is out, without an error envelope corrupting machine output.
    // Drift gets its OWN code — every failure exits 1, and a script's
    // `config diff --exit-code || alert` must not fire on an expired token
    // (`terraform plan -detailed-exitcode`'s 0/1/2 convention, with 1 kept
    // for errors to match the rest of the CLI). In TEXT mode only, a stderr
    // reason line precedes the exit so a CI log doesn't show only "exit code
    // 2" with no explanation (db lint's fail-on reason line is the same
    // idea); machine modes stay byte-identical.
    if (flags.exitCode && changeSet.counts.total > 0) {
      if (output.format === "text") {
        yield* output.raw("Exiting 2: configuration differences found (--exit-code).\n", "stderr");
      }
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
