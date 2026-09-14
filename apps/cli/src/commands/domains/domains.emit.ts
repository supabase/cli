import { Effect, Option } from "effect";

import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { encodeEnv, encodeGoJson } from "../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goAny,
  goBool,
  goPtr,
  goSlice,
  goString,
  goStruct,
} from "../../command-internal/go-struct-output.encoders.ts";
import { formatHostnameStatus, type HostnameResponse } from "./domains.format.ts";

/**
 * Struct spec for the custom-hostname response, driving `-o yaml`/`-o toml`
 * key casing for every hostname subcommand; non-pointer fields are zero-filled.
 */
const GO_HOSTNAME_RESPONSE = goStruct([
  ["custom_hostname", goString],
  [
    "data",
    goStruct([
      ["errors", goSlice(goAny)],
      ["messages", goSlice(goAny)],
      [
        "result",
        goStruct([
          ["custom_origin_server", goString],
          ["hostname", goString],
          ["id", goString],
          [
            "ownership_verification",
            goStruct([
              ["name", goString],
              ["type", goString],
              ["value", goString],
            ]),
          ],
          [
            "ssl",
            goStruct([
              ["status", goString],
              ["validation_errors", goPtr(goSlice(goStruct([["message", goString]])))],
              [
                "validation_records",
                goSlice(
                  goStruct([
                    ["txt_name", goString],
                    ["txt_value", goString],
                  ]),
                ),
              ],
            ]),
          ],
          ["status", goString],
          ["verification_errors", goPtr(goSlice(goString))],
        ]),
      ],
      ["success", goBool],
    ]),
  ],
  ["status", goString],
]);

function normalizeHostnameResponse(response: HostnameResponse): Record<string, unknown> {
  return {
    ...response,
    status: response.status ?? "",
    custom_hostname: response.custom_hostname ?? "",
    data: {
      ...response.data,
      result: {
        ...response.data.result,
        ownership_verification: response.data.result.ownership_verification ?? {
          type: "",
          name: "",
          value: "",
        },
        ssl: {
          ...response.data.result.ssl,
          validation_records: response.data.result.ssl.validation_records ?? [],
        },
      },
    },
  };
}

function terminateHumanStatus(status: string): string {
  if (status === "" || status.endsWith("\n")) {
    return status;
  }
  return `${status}\n`;
}

/**
 * Emits a custom-hostname response across all output modes:
 *
 *   - In `pretty`/text mode the human status goes to **stderr**,
 *     newline-terminated so a shell prompt cannot redraw over the last line;
 *     nothing goes to stdout.
 *   - In a structured `-o` mode (`json`/`yaml`/`toml`/`env`) the encoded
 *     response goes to **stdout** and the human status is suppressed.
 *   - `--include-raw-output` (deprecated) forces `-o` to `json` when unset or `pretty`.
 *   - For `--output-format json|stream-json` (no `-o` flag), emits a single
 *     structured `success` event and suppresses the stderr status.
 */
export const emitHostnameResult = Effect.fnUntraced(function* (
  response: HostnameResponse,
  includeRawOutput: boolean,
) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;

  const goFmt = Option.getOrUndefined(goOutputFlag);
  const effectiveGoFmt =
    includeRawOutput && (goFmt === undefined || goFmt === "pretty") ? "json" : goFmt;

  if (effectiveGoFmt === "json") {
    yield* output.raw(encodeGoJson(normalizeHostnameResponse(response)));
    return;
  }
  if (effectiveGoFmt === "yaml") {
    yield* output.raw(encodeGoYaml(response, GO_HOSTNAME_RESPONSE));
    return;
  }
  if (effectiveGoFmt === "toml") {
    yield* output.raw(encodeGoToml(response, GO_HOSTNAME_RESPONSE));
    return;
  }
  if (effectiveGoFmt === "env") {
    yield* output.raw(encodeEnv(normalizeHostnameResponse(response)) + "\n");
    return;
  }

  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", normalizeHostnameResponse(response));
    return;
  }

  yield* output.raw(terminateHumanStatus(formatHostnameStatus(response)), "stderr");
});
