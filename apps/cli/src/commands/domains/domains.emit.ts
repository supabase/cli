import { Effect, Option } from "effect";

import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { encodeEnv, encodeSortedJson } from "../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapeAny,
  shapeBool,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
} from "../../command-internal/struct-output.encoders.ts";
import { formatHostnameStatus, type HostnameResponse } from "./domains.format.ts";

/**
 * Struct spec for the custom-hostname response, driving `-o yaml`/`-o toml`
 * key casing for every hostname subcommand; non-pointer fields are zero-filled.
 */
const HOSTNAME_RESPONSE_SHAPE = shapeStruct([
  ["custom_hostname", shapeString],
  [
    "data",
    shapeStruct([
      ["errors", shapeSlice(shapeAny)],
      ["messages", shapeSlice(shapeAny)],
      [
        "result",
        shapeStruct([
          ["custom_origin_server", shapeString],
          ["hostname", shapeString],
          ["id", shapeString],
          [
            "ownership_verification",
            shapeStruct([
              ["name", shapeString],
              ["type", shapeString],
              ["value", shapeString],
            ]),
          ],
          [
            "ssl",
            shapeStruct([
              ["status", shapeString],
              ["validation_errors", shapePtr(shapeSlice(shapeStruct([["message", shapeString]])))],
              [
                "validation_records",
                shapeSlice(
                  shapeStruct([
                    ["txt_name", shapeString],
                    ["txt_value", shapeString],
                  ]),
                ),
              ],
            ]),
          ],
          ["status", shapeString],
          ["verification_errors", shapePtr(shapeSlice(shapeString))],
        ]),
      ],
      ["success", shapeBool],
    ]),
  ],
  ["status", shapeString],
]);

function normalizeHostnameResponse(response: HostnameResponse): Record<string, unknown> {
  const ownershipVerification = response.data.result.ownership_verification;
  const ssl = response.data.result.ssl;
  return {
    ...response,
    status: response.status ?? "",
    custom_hostname: response.custom_hostname ?? "",
    data: {
      ...response.data,
      result: {
        ...response.data.result,
        custom_origin_server: response.data.result.custom_origin_server ?? "",
        ownership_verification: {
          ...ownershipVerification,
          type: ownershipVerification?.type ?? "",
          name: ownershipVerification?.name ?? "",
          value: ownershipVerification?.value ?? "",
        },
        ssl: {
          ...ssl,
          status: ssl?.status ?? "",
          validation_records:
            ssl?.validation_records?.map((record) => ({
              ...record,
              txt_name: record.txt_name ?? "",
              txt_value: record.txt_value ?? "",
            })) ?? [],
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
  const outputFlag = yield* OutputFlag;

  const outputFlagFormat = Option.getOrUndefined(outputFlag);
  const effectiveOutputFlagFormat =
    includeRawOutput && (outputFlagFormat === undefined || outputFlagFormat === "pretty")
      ? "json"
      : outputFlagFormat;

  if (effectiveOutputFlagFormat === "json") {
    yield* output.raw(encodeSortedJson(normalizeHostnameResponse(response)));
    return;
  }
  if (effectiveOutputFlagFormat === "yaml") {
    yield* output.raw(encodeStructYaml(response, HOSTNAME_RESPONSE_SHAPE));
    return;
  }
  if (effectiveOutputFlagFormat === "toml") {
    yield* output.raw(encodeStructToml(response, HOSTNAME_RESPONSE_SHAPE));
    return;
  }
  if (effectiveOutputFlagFormat === "env") {
    yield* output.raw(encodeEnv(normalizeHostnameResponse(response)) + "\n");
    return;
  }

  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", normalizeHostnameResponse(response));
    return;
  }

  yield* output.raw(terminateHumanStatus(formatHostnameStatus(response)), "stderr");
});
