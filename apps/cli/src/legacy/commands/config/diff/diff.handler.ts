import {
  CLI_CONFIG_SCHEMA_URL,
  diffProjectConfig,
  fromApiProjectConfig,
} from "@supabase/config/effect";
import { loadCliConfig, remoteNameForProjectRef } from "@supabase/config/internal";
import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import {
  legacyParentNotLinkedMessage,
  legacyParentRefInvalidMessage,
  legacyParentRefTypoHint,
} from "../../../shared/legacy-parent-project-ref.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import {
  legacySanitizeInlineName,
  mapLegacyHttpError,
  sanitizeLegacyErrorBody,
} from "../../../shared/legacy-http-errors.ts";
import { legacyResolveConfigTarget } from "../config.target.ts";
import { legacyConfigApiScope, legacyConfigScopeLine } from "../config.format.ts";
import { legacyConfigProjectConfigTry } from "../config.project-config.ts";
import {
  legacyConfigReadStatusMessage,
  legacyUnexpectedStatusMessage,
} from "../config.read-status.ts";
import {
  legacyConfigDiffComparisonLine,
  legacyConfigDiffPayload,
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

const mapBranchResolveError = mapLegacyHttpError({
  networkError: LegacyConfigDiffBranchResolveNetworkError,
  statusError: LegacyConfigDiffBranchResolveStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: legacyUnexpectedStatusMessage,
});

/** Error construction for `legacyResolveConfigTarget` (`../config.target.ts`),
 * keeping `config diff`'s own tagged error classes and message wording. */
const configTargetErrors = {
  notLinked: (target: string) =>
    new LegacyConfigDiffBranchNotLinkedError({ message: legacyParentNotLinkedMessage(target) }),
  parentRefInvalid: (target: string) =>
    new LegacyConfigDiffParentRefInvalidError({ message: legacyParentRefInvalidMessage(target) }),
  branchNotFound: (target: string) =>
    new LegacyConfigDiffBranchNotFoundError({
      message: `Branch "${legacySanitizeInlineName(target)}" not found. Run \`supabase branches list\` to see available branches.${legacyParentRefTypoHint(target)}`,
    }),
  branchNotReady: (target: string) =>
    new LegacyConfigDiffBranchNotReadyError({
      message: `Branch "${legacySanitizeInlineName(target)}" has no project ref yet. Wait for it to finish provisioning, then retry.`,
    }),
  mapResolveError: mapBranchResolveError,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legacyConfigDiff = Effect.fn("legacy.config.diff")(function* (
  flags: LegacyConfigDiffFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
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

    // 3. Resolve the comparison target — hoisted into `legacyResolveConfigTarget`
    // (`../config.target.ts`, shared with `config pull`, CLI-2064). See that
    // function's doc comment for the full eager-parent-ref-before-any-spinner
    // and lazy-UUID-parent-resolution rules this preserves.
    const { ref, branch } = yield* legacyResolveConfigTarget(requested, configTargetErrors);
    resolvedRef = ref;

    // 4. Apply the matching `[remotes.*]` overlay (ADR 0018) now that the
    // target ref is known. Only a config whose remotes actually MATCH the
    // resolved ref reloads — matched against the RAW, pre-`env()`-
    // interpolation `project_id` literal (`rawDocument`), mirroring
    // `@supabase/config`'s own remote-selection rule. An `env(REF)`-spelled
    // `[remotes.*].project_id` that happens to RESOLVE to `ref` must not
    // match here (CLI-2287): matching the resolved value would both apply an
    // overlay the loader itself would never select, and force a second
    // `loadLocalConfig` reload whose load-time deprecation warnings would
    // then print twice. Every other config keeps the step-2 load. The narrow
    // remaining double-print (a matching remote AND a deprecated section) is
    // the price of validating before the network call, which is worse to
    // give up.
    const remoteMatchesRef =
      remoteNameForProjectRef(loaded.rawDocument?.["remotes"], ref) !== undefined;
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
        message: legacyConfigReadStatusMessage(response.status, body, ref),
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
    // bug in this package pairing, so it stays a defect
    // (`legacyConfigProjectConfigTry`, shared with `config pull`/`config push`).
    const remote = yield* legacyConfigProjectConfigTry(() => fromApiProjectConfig(responseJson));

    // 7. Classify. The loaded pair carries the raw merged document (declared
    // keys) and the env-var origins; `diffProjectConfig` derives the local
    // convergence projection from it, so the same `ProjectConfigParseError`
    // boundary applies here.
    const changeSet = yield* legacyConfigProjectConfigTry(() =>
      diffProjectConfig({ local: loaded, remote }),
    );

    const data = isRecord(responseJson) ? responseJson["data"] : undefined;
    const scope = legacyConfigApiScope(
      isRecord(data) && isRecord(data["attributes"]) ? data["attributes"] : {},
    );
    yield* output.raw(legacyConfigScopeLine(scope), "stderr");

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
