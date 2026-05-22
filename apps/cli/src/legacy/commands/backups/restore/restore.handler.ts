import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  LegacyBackupRestoreNetworkError,
  LegacyBackupRestoreUnexpectedStatusError,
  mapLegacyBackupHttpError,
} from "../backups.errors.ts";
import type { LegacyBackupsRestoreFlags } from "./restore.command.ts";

const mapRestoreError = mapLegacyBackupHttpError({
  networkError: LegacyBackupRestoreNetworkError,
  statusError: LegacyBackupRestoreUnexpectedStatusError,
  networkMessage: (cause) => `failed to restore backup: ${cause}`,
  statusMessage: (status, body) => `unexpected restore backup status ${status}: ${body}`,
});

export const legacyBackupsRestore = Effect.fn("legacy.backups.restore")(function* (
  flags: LegacyBackupsRestoreFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);
  const recoveryTimeTargetUnix = Option.getOrElse(flags.timestamp, () => 0);

  // Mirror Go's PersistentPostRun — cache + telemetry flush whether the main
  // call succeeds or fails.
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
