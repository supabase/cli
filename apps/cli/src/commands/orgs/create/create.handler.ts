import type { V1CreateAnOrganizationOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { encodeGoToml, encodeGoYaml } from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { GO_ORGANIZATION_RESPONSE } from "../orgs.go-payload.ts";
import { OrgsCreateNetworkError, OrgsCreateUnexpectedStatusError } from "../orgs.errors.ts";
import { renderOrgsListTable } from "../orgs.format.ts";
import type { OrgsCreateFlags } from "./create.command.ts";

type CreatedOrganization = typeof V1CreateAnOrganizationOutput.Type;

const mapCreateError = mapHttpError({
  networkError: OrgsCreateNetworkError,
  statusError: OrgsCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create organization: ${cause}`,
  statusMessage: (status, body) => `unexpected create organization status ${status}: ${body}`,
});

export const orgsCreate = Effect.fn("orgs.create")(function* (flags: OrgsCreateFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    // Spinner runs only in text mode — it would corrupt machine-readable
    // stdout. The output-routing branches below dispatch on `goFmt`, but the
    // spinner uses `output.format` because `--output pretty` keeps the format
    // as "text" while requiring the table render; both paths need the spinner.
    const creating =
      output.format === "text" ? yield* output.task("Creating organization...") : undefined;
    const created: CreatedOrganization = yield* api.v1
      .createAnOrganization({ name: flags.name })
      .pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        Effect.catch(mapCreateError),
      );
    yield* creating?.clear() ?? Effect.void;

    const goFmt = Option.getOrUndefined(goOutputFlag);

    // `fmt.Println("Created organization:", id)` is printed once before the
    // format switch. The preamble is repeated inside each Go-format branch
    // rather than hoisted, so the TS `--output-format json` / `stream-json`
    // paths (which emit a single structured event below) stay preamble-free.
    const preamble = `Created organization: ${created.id}\n`;

    if (goFmt === "json") {
      yield* output.raw(preamble);
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeGoYaml(created, GO_ORGANIZATION_RESPONSE));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeGoToml(created, GO_ORGANIZATION_RESPONSE));
      return;
    }
    if (goFmt === "env") {
      yield* output.raw(preamble);
      yield* output.raw(encodeEnv(created) + "\n");
      return;
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("Created organization", { ...created });
      return;
    }

    yield* output.raw(preamble);
    yield* output.raw(renderOrgsListTable([created]));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
