import type { V1CreateAnOrganizationOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyOrgsCreateNetworkError,
  LegacyOrgsCreateUnexpectedStatusError,
} from "../orgs.errors.ts";
import { renderOrgsListTable } from "../orgs.format.ts";
import type { LegacyOrgsCreateFlags } from "./create.command.ts";

type CreatedOrganization = typeof V1CreateAnOrganizationOutput.Type;

const mapCreateError = mapLegacyHttpError({
  networkError: LegacyOrgsCreateNetworkError,
  statusError: LegacyOrgsCreateUnexpectedStatusError,
  networkMessage: (cause) => `failed to create organization: ${cause}`,
  statusMessage: (status, body) => `unexpected create organization status ${status}: ${body}`,
});

export const legacyOrgsCreate = Effect.fn("legacy.orgs.create")(function* (
  flags: LegacyOrgsCreateFlags,
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

    // Go calls `fmt.Println("Created organization:", id)` once before its
    // format switch (`apps/cli-go/internal/orgs/create/create.go:22`). We
    // repeat the preamble inside each Go-format branch rather than hoisting
    // it, so the TS `--output-format json` / `stream-json` paths (which emit
    // a single structured event below) stay preamble-free.
    const preamble = `Created organization: ${created.id}\n`;

    if (goFmt === "json") {
      yield* output.raw(preamble);
      yield* output.raw(encodeGoJson(created));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeYaml(created));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeToml(created) + "\n");
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
