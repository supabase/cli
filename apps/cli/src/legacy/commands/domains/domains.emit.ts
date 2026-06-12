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

function normalizeLegacyHostnameResponse(response: LegacyHostnameResponse): LegacyHostnameResponse {
  if (response.data.result.ssl.validation_records !== undefined) {
    return response;
  }
  return {
    ...response,
    data: {
      ...response.data,
      result: {
        ...response.data.result,
        ssl: {
          ...response.data.result.ssl,
          validation_records: [],
        },
      },
    },
  };
}

/**
 * Emit a custom-hostname response across all output modes, mirroring the Go
 * subcommands (`apps/cli-go/internal/hostnames/{get,create,activate,reverify}`):
 *
 *   - In `pretty`/text mode the human status text goes to **stderr** (Go's
 *     `PrintStatus`), and nothing goes to stdout.
 *   - In a structured Go `-o` mode (`json`/`yaml`/`toml`/`env`) the encoded
 *     response goes to **stdout** and the human status is **suppressed**. Go
 *     technically still writes `PrintStatus` to stderr here. Suppressing keeps
 *     stdout/stderr stable for machine consumers; the parity e2e opts in to
 *     normalizing Go's stderr-only status instead of depending on upgrade-check
 *     output to erase it.
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
  const normalizedResponse = normalizeLegacyHostnameResponse(response);

  const goFmt = Option.getOrUndefined(goOutputFlag);
  const effectiveGoFmt =
    includeRawOutput && (goFmt === undefined || goFmt === "pretty") ? "json" : goFmt;

  if (effectiveGoFmt === "json") {
    yield* output.raw(encodeGoJson(normalizedResponse));
    return;
  }
  if (effectiveGoFmt === "yaml") {
    yield* output.raw(encodeYaml(normalizedResponse));
    return;
  }
  if (effectiveGoFmt === "toml") {
    yield* output.raw(encodeToml(normalizedResponse) + "\n");
    return;
  }
  if (effectiveGoFmt === "env") {
    yield* output.raw(encodeEnv(normalizedResponse) + "\n");
    return;
  }

  // goFmt is undefined or "pretty" — defer to the TS --output-format mode.
  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", normalizedResponse);
    return;
  }

  // text mode (Go pretty parity): status to stderr, nothing to stdout.
  yield* output.raw(formatHostnameStatus(normalizedResponse), "stderr");
});
