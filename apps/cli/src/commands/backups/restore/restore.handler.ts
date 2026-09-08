import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  BackupRestoreNetworkError,
  BackupRestoreUnexpectedStatusError,
} from "../backups.errors.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import type { BackupsRestoreFlags } from "./restore.command.ts";

const mapRestoreError = mapHttpError({
  networkError: BackupRestoreNetworkError,
  statusError: BackupRestoreUnexpectedStatusError,
  networkMessage: (cause) => `failed to restore backup: ${cause}`,
  statusMessage: (status, body) => `unexpected restore backup status ${status}: ${body}`,
});

export const backupsRestore = Effect.fn("backups.restore")(function* (flags: BackupsRestoreFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);
  const recoveryTimeTargetUnix = Option.getOrElse(flags.timestamp, () => 0);

  // Cache + telemetry flush whether the main call succeeds or fails.
  yield* Effect.gen(function* () {
    // Spinner only in human-facing text mode — see list.handler.ts.
    const restoring =
      output.format === "text" ? yield* output.task("Initiating PITR restore...") : undefined;
    yield* api.v1
      .restorePitrBackup({ ref, recovery_time_target_unix: recoveryTimeTargetUnix })
      .pipe(
        Effect.tapError(() => restoring?.fail() ?? Effect.void),
        Effect.catch(mapRestoreError),
      );
    yield* restoring?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // Go ignores --output entirely (restore.go:22) and always writes the text line to stderr.
    // We mirror that for every Go --output value except `json`, where we provide a TS-only
    // structured payload (Go has no JSON for restore — adding one is non-breaking).
    if (goFmt === "json") {
      yield* output.raw(
        JSON.stringify({ message: "Started PITR restore", project_ref: ref }, null, 2) + "\n",
      );
      return;
    }

    if (goFmt === undefined && (output.format === "json" || output.format === "stream-json")) {
      yield* output.success("Started PITR restore", { project_ref: ref });
      return;
    }

    // pretty/yaml/toml/env (Go-compat) + TS text mode → byte-identical text line on stderr.
    yield* output.raw(`Started PITR restore: ${ref}\n`, "stderr");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
