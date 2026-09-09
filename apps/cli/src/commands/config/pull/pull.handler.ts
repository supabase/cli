import { Effect, FileSystem, Option } from "effect";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { openConfigPullSource, runConfigPull } from "../../../command-internal/config-pull.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYes, OutputFlag } from "../../../command-internal/global-flags.ts";
import { configTargetErrorsFor, resolveConfigTarget } from "../config.target.ts";
import { unexpectedStatusMessage } from "../config.read-status.ts";
import {
  ConfigPullBranchNotFoundError,
  ConfigPullBranchNotLinkedError,
  ConfigPullBranchNotReadyError,
  ConfigPullOutputFlagUnsupportedError,
  ConfigPullParentRefInvalidError,
  ConfigPullReadNetworkError,
  ConfigPullReadStatusError,
  ConfigPullWorkdirError,
} from "./pull.errors.ts";
import type { ConfigPullFlags } from "./pull.command.ts";

const mapBranchResolveError = mapHttpError({
  networkError: ConfigPullReadNetworkError,
  statusError: ConfigPullReadStatusError,
  networkMessage: (cause) => `failed to resolve branch: ${cause}`,
  statusMessage: unexpectedStatusMessage,
});
const configTargetErrors = configTargetErrorsFor({
  notLinked: ConfigPullBranchNotLinkedError,
  parentRefInvalid: ConfigPullParentRefInvalidError,
  branchNotFound: ConfigPullBranchNotFoundError,
  branchNotReady: ConfigPullBranchNotReadyError,
});

/**
 * `configPull` — the command-facing entry point (steps 1-4): rejects
 * `-o/--output`, opens the base config source (`openConfigPullSource`)
 * BEFORE any network call or target resolution, resolves the target, then
 * delegates to {@link runConfigPull} for the rest.
 */
export const configPull = Effect.fn("config.pull")(function* (flags: ConfigPullFlags) {
  const goOutputFlag = yield* OutputFlag;
  const yes = yield* resolveYes;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // An empty `--project-ref`/`--remote-label` value is absent, mirroring the
  // target resolver's own rule.
  const requested = Option.filter(flags.projectRef, (value) => value.length > 0);
  const remoteLabel = Option.getOrUndefined(
    Option.filter(flags.remoteLabel, (value) => value.length > 0),
  );

  // Written once the target is known, so the linked-project cache finalizer
  // below only fires for invocations that got that far (mirrors `config
  // diff`).
  let resolvedRef: string | undefined;

  yield* Effect.gen(function* () {
    // 1. Reject the Go-compat `-o/--output` flag outright, before anything
    // else — `config pull` is a net-new TS command with no Go parity
    // contract (CLI-2156, mirrors `config diff`).
    if (Option.isSome(goOutputFlag)) {
      return yield* new ConfigPullOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.",
      });
    }

    // 1.5. The resolved `--workdir`/`SUPABASE_WORKDIR` must exist and be a
    // directory before the base config source is opened — distinguishes
    // "the directory doesn't exist" from "it exists but holds no
    // `supabase/` project" (the step 2-3 load below).
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigPullWorkdirError({ message: error.message })),
    );

    // 2-3. Open the base config source (load with NO `[remotes.*]` overlay,
    // paired with its on-disk text) BEFORE any network call or target
    // resolution — a missing file must point at `supabase init` rather than
    // the resolver's not-linked error, and a malformed document must not
    // burn a branch-resolution round trip.
    const source = yield* openConfigPullSource();

    // 4. Resolve the pull target — hoisted into `resolveConfigTarget`
    // (`../config.target.ts`, shared with `config diff`/`config push`, CLI-2064).
    const { ref, branch } = yield* resolveConfigTarget(
      requested,
      configTargetErrors,
      mapBranchResolveError,
    );
    resolvedRef = ref;

    yield* runConfigPull({
      target: { ref, branch },
      remoteLabel,
      dryRun: flags.dryRun,
      force: flags.force,
      yes,
      source,
    });
  }).pipe(
    // CLI Invariant #1: telemetry flushes on EVERY invocation —
    // including load/parse failures and branch-resolution failures — while
    // the linked-project cache write needs a resolved ref, so it fires
    // exactly when one exists (mirrors `config diff`).
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
