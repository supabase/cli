import type { V1ListAllOrganizationsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { GO_ORGS_LIST, GO_ORGS_TOML_WRAPPER } from "../orgs.go-payload.ts";
import {
  OrgsEnvNotSupportedError,
  OrgsListNetworkError,
  OrgsListUnexpectedStatusError,
} from "../orgs.errors.ts";
import { renderOrgsListTable } from "../orgs.format.ts";
import type { OrgsListFlags } from "./list.command.ts";

type Organizations = typeof V1ListAllOrganizationsOutput.Type;

const mapListError = mapHttpError({
  networkError: OrgsListNetworkError,
  statusError: OrgsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list organizations: ${cause}`,
  statusMessage: (status, body) => `unexpected list organizations status ${status}: ${body}`,
});

export const orgsList = Effect.fn("orgs.list")(function* (_flags: OrgsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    // Spinner only runs in text mode, since it would corrupt machine-readable stdout. It
    // gates on output.format rather than goFmt because --output pretty keeps the format
    // "text" while still rendering the table.
    const fetching =
      output.format === "text" ? yield* output.task("Fetching organizations...") : undefined;
    const orgs: Organizations = yield* api.v1.listAllOrganizations().pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new OrgsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(orgs));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(orgs, GO_ORGS_LIST));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeGoToml({ organizations: orgs }, GO_ORGS_TOML_WRAPPER));
      return;
    }

    // goFmt is unset or "pretty" here; fall through to --output-format or the table.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { organizations: orgs });
      return;
    }

    yield* output.raw(renderOrgsListTable(orgs));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
