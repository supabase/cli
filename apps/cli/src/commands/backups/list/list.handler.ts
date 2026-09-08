import type { V1ListAllBackupsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { BackupListNetworkError, BackupListUnexpectedStatusError } from "../backups.errors.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goBool,
  goInt,
  goPtr,
  goSlice,
  goString,
  goStruct,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { formatTimestamp } from "../../../command-internal/timestamp.format.ts";
import { formatRegion } from "../backups.format.ts";
import type { BackupsListFlags } from "./list.command.ts";

/** Type shape for `api.V1BackupsResponse` (`apps/cli-go/pkg/api/types.gen.go`). */
const GO_BACKUPS_RESPONSE = goStruct([
  [
    "backups",
    goSlice(
      goStruct([
        ["id", goInt],
        ["inserted_at", goString],
        ["is_physical_backup", goBool],
        ["status", goString],
      ]),
    ),
  ],
  [
    "physical_backup_data",
    goStruct([
      ["earliest_physical_backup_date_unix", goPtr(goInt)],
      ["latest_physical_backup_date_unix", goPtr(goInt)],
    ]),
  ],
  ["pitr_enabled", goBool],
  ["region", goString],
  ["walg_enabled", goBool],
]);

type BackupsResponse = typeof V1ListAllBackupsOutput.Type;

const mapListError = mapHttpError({
  networkError: BackupListNetworkError,
  statusError: BackupListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list physical backups: ${cause}`,
  statusMessage: (status, body) => `unexpected list backup status ${status}: ${body}`,
});

const PITR_HEADERS = ["REGION", "WALG", "PITR", "EARLIEST TIMESTAMP", "LATEST TIMESTAMP"] as const;

const LOGICAL_HEADERS = ["REGION", "BACKUP TYPE", "STATUS", "CREATED AT (UTC)"] as const;

function renderPitrTable(response: BackupsResponse): string {
  const region = formatRegion(response.region);
  const earliest = response.physical_backup_data.earliest_physical_backup_date_unix ?? 0;
  const latest = response.physical_backup_data.latest_physical_backup_date_unix ?? 0;
  return renderGlamourTable(PITR_HEADERS, [
    [
      region,
      response.walg_enabled ? "true" : "false",
      response.pitr_enabled ? "true" : "false",
      String(earliest),
      String(latest),
    ],
  ]);
}

function renderLogicalTable(response: BackupsResponse): string {
  const region = formatRegion(response.region);
  const rows = response.backups.map((backup) => [
    region,
    backup.is_physical_backup ? "PHYSICAL" : "LOGICAL",
    backup.status,
    formatTimestamp(backup.inserted_at),
  ]);
  return renderGlamourTable(LOGICAL_HEADERS, rows);
}

export const backupsList = Effect.fn("backups.list")(function* (flags: BackupsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Write the linked-project cache and persist the telemetry state file
  // whether the main API call succeeds or fails.
  yield* Effect.gen(function* () {
    // The fetching spinner is only meaningful in human-facing text mode — in JSON / stream-json
    // it would surface dangling `[task] start:` lines on stderr with no completion message.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching backups...") : undefined;
    const response = yield* api.v1.listAllBackups({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(response, { nullForEmptyArrays: ["backups"] }));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(response, GO_BACKUPS_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      // The schema decodes the PITR-only `"backups": null` to `[]` (see the
      // `nullForEmptyArrays` JSON hint above); mirror that by treating an
      // empty list as a nil slice, which BurntSushi omits entirely.
      yield* output.raw(
        encodeGoToml(
          {
            ...response,
            backups: response.backups.length > 0 ? response.backups : undefined,
          },
          GO_BACKUPS_RESPONSE,
        ),
      );
      return;
    }
    if (goFmt === "env") {
      yield* output.raw(encodeEnv(response) + "\n");
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for JSON/stream-json,
    // otherwise render the Glamour-styled table (Go --output pretty parity).
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", response);
      return;
    }

    const table =
      response.backups.length > 0 ? renderLogicalTable(response) : renderPitrTable(response);
    yield* output.raw(table);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
