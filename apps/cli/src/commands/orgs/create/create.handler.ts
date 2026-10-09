import type { V1CreateAnOrganizationOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeEnv, encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
} from "../../../command-internal/struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { ORGANIZATION_RESPONSE_SHAPE } from "../orgs.response-shape.ts";
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
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    // Spinner only runs in text mode, since it would corrupt machine-readable stdout. It
    // gates on output.format rather than outputFlagFormat because --output pretty keeps the format
    // "text" while still rendering the table.
    const creating =
      output.format === "text" ? yield* output.task("Creating organization...") : undefined;
    const created: CreatedOrganization = yield* api.v1
      .createAnOrganization({ name: flags.name })
      .pipe(
        Effect.tapError(() => creating?.fail() ?? Effect.void),
        Effect.catch(mapCreateError),
      );
    yield* creating?.clear ?? Effect.void;

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    // Printed once before the format switch, but only for the `-o` branches — the
    // --output-format json/stream-json paths emit a single structured event instead and
    // stay preamble-free.
    const preamble = `Created organization: ${created.id}\n`;

    if (outputFlagFormat === "json") {
      yield* output.raw(preamble);
      yield* output.raw(encodeSortedJson(created));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeStructYaml(created, ORGANIZATION_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      yield* output.raw(preamble);
      yield* output.raw(encodeStructToml(created, ORGANIZATION_RESPONSE_SHAPE));
      return;
    }
    if (outputFlagFormat === "env") {
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
