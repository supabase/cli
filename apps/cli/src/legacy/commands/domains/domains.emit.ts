import { Effect, Option } from "effect";

import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../shared/legacy-go-output.encoders.ts";
import { formatHostnameStatus, type LegacyHostnameResponse } from "./domains.format.ts";

/**
 * Emit a custom-hostname response across all output modes, mirroring the Go
 * subcommands (`apps/cli-go/internal/hostnames/{get,create,activate,reverify}`):
 *
 *   - Go always writes the human status text to **stderr** (`PrintStatus`),
 *     then, when `-o != pretty`, encodes the full response to **stdout**.
 *   - `--include-raw-output` (deprecated) forces `-o` to `json` when it is unset
 *     or `pretty`.
 *   - For the TS-native `--output-format json|stream-json` modes (no Go `-o`),
 *     emit a single structured `success` event and suppress the stderr status.
 */
export const emitLegacyHostnameResult = Effect.fnUntraced(function* (
  response: LegacyHostnameResponse,
  includeRawOutput: boolean,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;

  const goFmt = Option.getOrUndefined(goOutputFlag);
  const effectiveGoFmt =
    includeRawOutput && (goFmt === undefined || goFmt === "pretty") ? "json" : goFmt;

  const statusText = formatHostnameStatus(response);

  if (effectiveGoFmt === "json") {
    yield* output.raw(statusText, "stderr");
    yield* output.raw(encodeGoJson(response));
    return;
  }
  if (effectiveGoFmt === "yaml") {
    yield* output.raw(statusText, "stderr");
    yield* output.raw(encodeYaml(response));
    return;
  }
  if (effectiveGoFmt === "toml") {
    yield* output.raw(statusText, "stderr");
    yield* output.raw(encodeToml(response) + "\n");
    return;
  }
  if (effectiveGoFmt === "env") {
    yield* output.raw(statusText, "stderr");
    yield* output.raw(encodeEnv(response) + "\n");
    return;
  }

  // goFmt is undefined or "pretty" — defer to the TS --output-format mode.
  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", response);
    return;
  }

  // text mode (Go pretty parity): status to stderr, nothing to stdout.
  yield* output.raw(statusText, "stderr");
});
