import type { V1ListAllOrganizationsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyOrgsEnvNotSupportedError,
  LegacyOrgsListNetworkError,
  LegacyOrgsListUnexpectedStatusError,
} from "../orgs.errors.ts";
import { renderOrgsListTable } from "../orgs.format.ts";
import type { LegacyOrgsListFlags } from "./list.command.ts";

type Organizations = typeof V1ListAllOrganizationsOutput.Type;

const mapListError = mapLegacyHttpError({
  networkError: LegacyOrgsListNetworkError,
  statusError: LegacyOrgsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list organizations: ${cause}`,
  statusMessage: (status, body) => `unexpected list organizations status ${status}: ${body}`,
});

export const legacyOrgsList = Effect.fn("legacy.orgs.list")(function* (
  _flags: LegacyOrgsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    // Spinner runs only in text mode — it would corrupt machine-readable
    // stdout. The output-routing branches below dispatch on `goFmt`, but the
    // spinner uses `output.format` because `--output pretty` keeps the format
    // as "text" while requiring the table render; both paths need the spinner.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching organizations...") : undefined;
    const orgs: Organizations = yield* api.v1.listAllOrganizations().pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyOrgsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(orgs));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(orgs));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ organizations: orgs }) + "\n");
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for
    // JSON/stream-json, otherwise render the Glamour-styled table.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { organizations: orgs });
      return;
    }

    yield* output.raw(renderOrgsListTable(orgs));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
