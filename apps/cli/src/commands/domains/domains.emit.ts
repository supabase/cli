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
 * Type shape for `api.UpdateCustomHostnameResponse`
 * (`apps/cli-go/pkg/api/types.gen.go`) — every hostname subcommand encodes
 * this struct for `-o yaml` / `-o toml`, so keys derive from these field
 * names and non-pointer fields are zero-filled (CLI-1975).
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
 * Emit a custom-hostname response across all output modes:
 *
 *   - In `pretty`/text mode the human status text goes to **stderr**, and
 *     nothing goes to stdout. Unlike the reference implementation's
 *     no-newline `Fprintf` branches, the final human status here is
 *     newline-terminated so an interactive shell prompt cannot redraw over
 *     the last line.
 *   - In a structured `-o` mode (`json`/`yaml`/`toml`/`env`) the encoded
 *     response goes to **stdout** and the human status is **suppressed**,
 *     keeping stdout/stderr stable for machine consumers.
 *   - `--include-raw-output` (deprecated) forces `-o` to `json` when it is
 *     unset or `pretty`.
 *   - For the TS-native `--output-format json|stream-json` modes (no `-o`
 *     flag), emit a single structured `success` event and suppress the
 *     stderr status.
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

  // goFmt is undefined or "pretty" — defer to the TS --output-format mode.
  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", normalizeHostnameResponse(response));
    return;
  }

  // text mode (Go pretty parity): status to stderr, nothing to stdout.
  yield* output.raw(terminateHumanStatus(formatHostnameStatus(response)), "stderr");
});
