import { prepareArtifactSelection } from "@supabase/stack/internal/artifacts";
import type { PreparedRelease } from "@supabase/stack/internal/artifacts";
import { Effect, Path, Ref, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import {
  LockResolutionError,
  lockedResolution,
  type LockedResolution,
  LOCK_FILE,
} from "../../../../command-internal/stack-lock.ts";
import {
  selectStackRuntime,
  type StackRuntime,
} from "../../../../command-internal/stack-runtime.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { mapTargetError, rejectStackOutput } from "../stack.shared.ts";
import type { StackInstallFlags } from "./install.command.ts";
import {
  StackCommandInstallError,
  stackInstallError,
  stackInstallRuntimeError,
} from "./install.errors.ts";

const lockReport = (resolution: LockedResolution | undefined) =>
  resolution === undefined
    ? null
    : {
        file: LOCK_FILE,
        written: resolution.written,
        added: resolution.changes.flatMap(({ service, from, to }) =>
          from === undefined ? [{ service, to }] : [],
        ),
        changed: resolution.changes.flatMap(({ service, from, to }) =>
          from === undefined ? [] : [{ service, from, to }],
        ),
        unchanged: resolution.unchanged,
      };

const count = (releases: ReadonlyArray<PreparedRelease>, outcome: PreparedRelease["outcome"]) =>
  releases.filter((release) => release.outcome === outcome).length;

const render = (
  runtime: StackRuntime,
  resolution: LockedResolution | undefined,
  releases: ReadonlyArray<PreparedRelease>,
) => {
  const lock =
    resolution === undefined
      ? "No supabase/config.toml: using the versions bundled with the CLI; no lock written."
      : resolution.written
        ? `Wrote ${LOCK_FILE}.`
        : `${LOCK_FILE} is up to date.`;
  const downloaded = count(releases, "downloaded");
  const lines = [
    lock,
    `Downloaded ${downloaded} of ${releases.length} ${runtime === "native" ? "archives" : "images"} for the ${runtime} runtime; ${releases.length - downloaded} already present.`,
    ...releases.map(({ service, release, outcome }) => `  ${service} ${release} (${outcome})`),
  ];
  return `${lines.join("\n")}\n`;
};

/** Resolves and locks the service versions, then downloads what the lock pins without starting a stack. */
export const stackInstall = Effect.fn("experimental.stack.install")(function* (
  flags: StackInstallFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const runtimeInfo = yield* RuntimeInfo;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(mapTargetError((props) => new StackCommandInstallError(props))),
    );

    const pickRuntime = selectStackRuntime(
      flags.runtime === "auto" ? undefined : flags.runtime,
    ).pipe(Effect.mapError(stackInstallRuntimeError), Effect.withSpan("install.runtime"));
    const picked = yield* Ref.make<StackRuntime | undefined>(undefined);
    const resolved = yield* Ref.make<LockedResolution | undefined>(undefined);
    const resolve = lockedResolution({ frozen: flags.frozen, output });
    const config = yield* loadStackConfig(settings.workdir, {
      frozen: flags.frozen,
      publishesLock: true,
      // The runtime is checked after the config validates and before the lock is touched.
      selection: (request) =>
        pickRuntime.pipe(
          Effect.tap((runtime) => Ref.set(picked, runtime)),
          Effect.andThen(resolve(request)),
          Effect.tap((resolution) => Ref.set(resolved, resolution)),
          Effect.map((resolution) => resolution.selection),
        ),
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StackCommandInstallError
          ? error
          : new StackCommandInstallError({
              reason: Schema.is(LockResolutionError)(error) ? "lock" : "invalid-config",
              message: error.message,
              cause: error,
            }),
      ),
      Effect.withSpan("install.resolve"),
    );
    const resolution = yield* Ref.get(resolved);
    const runtime = (yield* Ref.get(picked)) ?? (yield* pickRuntime);

    const task =
      output.format === "text" ? yield* output.task("Downloading artifacts...") : undefined;
    const releases = yield* prepareArtifactSelection(config.selection, {
      runtime,
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
      platform: { os: runtimeInfo.platform, arch: runtimeInfo.arch },
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(stackInstallError),
      Effect.tapError(() => task?.fail() ?? Effect.void),
      Effect.withSpan("install.download"),
    );
    yield* task?.clear ?? Effect.void;

    const downloaded = count(releases, "downloaded");
    yield* Effect.annotateCurrentSpan({
      "install.runtime": runtime,
      "install.downloaded_count": downloaded,
      "install.cached_count": releases.length - downloaded,
      "install.lock_written": resolution?.written ?? false,
    });
    if (output.format === "text") yield* output.raw(render(runtime, resolution, releases));
    else
      yield* output.success("", {
        runtime,
        lock: lockReport(resolution),
        artifacts: releases,
        downloaded,
        cached: releases.length - downloaded,
      });
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
