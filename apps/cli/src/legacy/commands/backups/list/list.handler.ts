import type { V1ListAllBackupsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import {
  LegacyBackupListNetworkError,
  LegacyBackupListUnexpectedStatusError,
  mapLegacyBackupHttpError,
} from "../backups.errors.ts";
import { encodeEnv, encodeGoJson, encodeToml, encodeYaml } from "../backups.encoders.ts";
import { formatBackupTimestamp, formatRegion } from "../backups.format.ts";
import type { LegacyBackupsListFlags } from "./list.command.ts";

type BackupsResponse = typeof V1ListAllBackupsOutput.Type;

const mapListError = mapLegacyBackupHttpError({
  networkError: LegacyBackupListNetworkError,
  statusError: LegacyBackupListUnexpectedStatusError,
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
    formatBackupTimestamp(backup.inserted_at),
  ]);
  return renderGlamourTable(LOGICAL_HEADERS, rows);
}

export const legacyBackupsList = Effect.fn("legacy.backups.list")(function* (
  flags: LegacyBackupsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;

  const ref = yield* resolver.resolve(flags.projectRef);

  // The fetching spinner is only meaningful in human-facing text mode — in JSON / stream-json
  // it would surface dangling `[task] start:` lines on stderr with no completion message.
  const fetching = output.format === "text" ? yield* output.task("Fetching backups...") : undefined;
  const response = yield* api.v1.listAllBackups({ ref }).pipe(
    Effect.tapError(() => fetching?.fail() ?? Effect.void),
    Effect.catch(mapListError),
  );
  yield* fetching?.clear() ?? Effect.void;

  const goFmt = Option.getOrUndefined(goOutputFlag);

  if (goFmt === "json") {
    yield* output.raw(encodeGoJson(response));
    return;
  }
  if (goFmt === "yaml") {
    yield* output.raw(encodeYaml(response));
    return;
  }
  if (goFmt === "toml") {
    yield* output.raw(encodeToml(response) + "\n");
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
});
