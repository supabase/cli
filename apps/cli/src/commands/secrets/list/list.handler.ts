import { Effect, Option } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goPtr,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { listProjectSecrets } from "../../../command-internal/list-project-secrets.ts";
import { SecretsEnvNotSupportedError } from "../secrets.errors.ts";
import { renderSecretsListTable } from "../secrets.format.ts";
import type { SecretsListFlags } from "./list.command.ts";

/** Type shape for the secrets response, used to drive `-o yaml|toml` key casing (see `apps/cli-go/pkg/api/types.gen.go`). */
const GO_SECRET_RESPONSE = goStruct([
  ["name", goString],
  ["updated_at", goPtr(goString)],
  ["value", goString],
]);

const GO_SECRETS_LIST = goSlice(GO_SECRET_RESPONSE);

const GO_SECRETS_TOML_WRAPPER = goTomlListWrapper("secrets", GO_SECRET_RESPONSE);

export const secretsList = Effect.fn("secrets.list")(function* (flags: SecretsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  const ref = yield* resolver.resolve(flags.projectRef);

  // Write the linked-project cache and persist the telemetry state file
  // whether the main API call succeeds or fails.
  yield* Effect.gen(function* () {
    const sorted = yield* listProjectSecrets(ref);
    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new SecretsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(sorted));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(sorted, GO_SECRETS_LIST));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeGoToml({ secrets: sorted }, GO_SECRETS_TOML_WRAPPER));
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for JSON/stream-json,
    // otherwise render the Glamour-styled table (Go --output pretty parity).
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { secrets: sorted });
      return;
    }

    yield* output.raw(renderSecretsListTable(sorted));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
