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
import { encodeEnv, encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapeBool,
  shapeInt,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
} from "../../../command-internal/struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { formatTimestamp } from "../../../command-internal/timestamp.format.ts";
import { formatRegion } from "../../../command-internal/region.format.ts";
import type { BackupsListFlags } from "./list.command.ts";

/** Struct shape for `-o yaml|toml` encoding of the backups response. */
const BACKUPS_RESPONSE_SHAPE = shapeStruct([
  [
    "backups",
    shapeSlice(
      shapeStruct([
        ["id", shapeInt],
        ["inserted_at", shapeString],
        ["is_physical_backup", shapeBool],
        ["status", shapeString],
      ]),
    ),
  ],
  [
    "physical_backup_data",
    shapeStruct([
      ["earliest_physical_backup_date_unix", shapePtr(shapeInt)],
      ["latest_physical_backup_date_unix", shapePtr(shapeInt)],
    ]),
  ],
  ["pitr_enabled", shapeBool],
  ["region", shapeString],
  ["walg_enabled", shapeBool],
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
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // Spinner is text-mode only; in JSON/stream-json it would leave a dangling `[task] start:`
    // line on stderr with no completion message.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching backups...") : undefined;
    const response = yield* api.v1.listAllBackups({ ref }).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear ?? Effect.void;

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson(response, { nullForEmptyArrays: ["backups"] }));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw(encodeStructYaml(response, BACKUPS_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      // Treats an empty backups list as absent, matching the nullForEmptyArrays JSON handling
      // above.
      yield* output.raw(
        encodeStructToml(
          {
            ...response,
            backups: response.backups.length > 0 ? response.backups : undefined,
          },
          BACKUPS_RESPONSE_SHAPE,
        ),
      );
      return;
    }
    if (outputFlagFormat === "env") {
      yield* output.raw(encodeEnv(response) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", response);
      return;
    }

    const table =
      response.backups.length > 0 ? renderLogicalTable(response) : renderPitrTable(response);
    yield* output.raw(table);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
