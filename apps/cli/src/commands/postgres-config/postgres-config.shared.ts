import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../output/glamour-table.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeGoStructJsonBody,
  encodeYaml,
} from "../../command-internal/go-output.encoders.ts";
import { goFormatFloat } from "../../command-internal/go-float.ts";
import { sanitizeErrorBody } from "../../command-internal/http-errors.ts";
import { requestWithAuth } from "../../command-internal/raw-http.ts";
import { resolveAccessToken } from "../../command-internal/resolve-token.ts";
import {
  PostgresConfigGetNetworkError,
  PostgresConfigGetUnexpectedStatusError,
  PostgresConfigGetUnmarshalError,
} from "./postgres-config.errors.ts";

export type PostgresConfigMap = Record<string, unknown>;

function sortConfigEntries(config: PostgresConfigMap): Array<[string, unknown]> {
  return Object.entries(config).sort(([a], [b]) => a.localeCompare(b));
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return value;
  // Go renders each cell with `%+v` (`get.go:32-35`) on values from
  // `json.Unmarshal` into `map[string]any` — every JSON number is a `float64`,
  // so e.g. `1000000` prints as `1e+06`, not `1000000`.
  if (typeof value === "number") return goFormatFloat(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "<nil>";
  return JSON.stringify(value);
}

function renderPostgresConfigTable(config: PostgresConfigMap): string {
  return renderGlamourTable(
    ["Parameter", "Value"],
    sortConfigEntries(config).map(([key, value]) => [key, formatPrettyValue(value)]),
  );
}

function encodeTomlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // The reference decoder unmarshals the API response into `map[string]any`,
    // so every JSON number becomes a `float64`. Its TOML marshaller then prints
    // integral floats with a `.0` suffix (e.g. `max_connections = 100.0`). The
    // shared `encodeToml` (smol-toml) would emit `100` instead, so this command
    // cannot use it without breaking byte-for-byte compatibility.
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  if (value === null) return JSON.stringify("<nil>");
  return JSON.stringify(JSON.stringify(value));
}

// Hand-rolled to reproduce `float64` TOML rendering (see `encodeTomlScalar`).
// Intentionally does not delegate to the shared `encodeToml`/smol-toml encoder.
function encodePostgresConfigToml(config: PostgresConfigMap): string {
  const lines = sortConfigEntries(config).map(
    ([key, value]) => `${key} = ${encodeTomlScalar(value)}`,
  );
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

// `strconv.Atoi` parses into a 64-bit int (`update.go:43`).
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Exactly `strconv.ParseBool`'s accepted sets. `1`/`0` are also in them, but
// the integer branch below wins first, since `Atoi` runs before `ParseBool`
// (`update.go:43-48`).
const GO_TRUE_LITERALS = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_FALSE_LITERALS = new Set(["0", "f", "F", "FALSE", "false", "False"]);

/**
 * Coercion chain for `--config key=value` (`update.go:41-49`):
 * `strconv.Atoi` → `strconv.ParseBool` → keep as string. `Atoi` fails with
 * `ErrRange` on digits beyond int64, and a pure digit string is not a
 * `ParseBool` literal (only bare `1`/`0` are, and those fit in int64), so an
 * overflowing integer falls through to the verbatim string. `ParseBool` is
 * case-SENSITIVE over a fixed set — `tRuE` stays a string.
 *
 * Residual divergence: digits in `(2^53, 2^63)` fit int64, so the reference
 * implementation sends an exact JSON integer, while JS `Number` loses
 * precision there — `encodeGoStructJsonBody` is `JSON.stringify`, which
 * cannot emit exact int64 tokens beyond `Number.MAX_SAFE_INTEGER`.
 */
export function parseConfigValue(value: string): string | number | boolean {
  if (/^[+-]?\d+$/.test(value)) {
    const asBigInt = BigInt(value.replace(/^\+/, ""));
    if (asBigInt >= INT64_MIN && asBigInt <= INT64_MAX) {
      return Number.parseInt(value, 10);
    }
    return value;
  }
  if (GO_TRUE_LITERALS.has(value)) return true;
  if (GO_FALSE_LITERALS.has(value)) return false;
  return value;
}

export function normalizeTimeoutConfig(config: PostgresConfigMap): void {
  for (const [key, value] of Object.entries(config)) {
    if (key.endsWith("_timeout") && typeof value !== "string") {
      config[key] = String(value);
    }
  }
}

function mapTransportMessage<E>(
  cause: unknown,
  message: (description: string) => string,
  wrap: (args: { readonly message: string }) => E,
): E {
  if (HttpClientError.isHttpClientError(cause)) {
    const description = cause.reason.description ?? cause.reason._tag;
    return wrap({ message: message(description) });
  }
  return wrap({ message: message(String(cause)) });
}

function parseJsonObject<E>(
  rawBody: string,
  errorMessage: (description: string) => string,
  wrap: (args: { readonly message: string }) => E,
): Effect.Effect<PostgresConfigMap, E> {
  return Effect.try({
    try: () => {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("unexpected non-object JSON response");
      }
      return parsed as PostgresConfigMap;
    },
    catch: (cause) => wrap({ message: errorMessage(String(cause)) }),
  });
}

export const fetchCurrentPostgresConfig = Effect.fn("postgres-config.fetch-current")(function* (
  ref: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const cliSettings = yield* CommandSettings;
  const tokenOpt = yield* resolveAccessToken;

  const request = requestWithAuth(
    HttpClientRequest.get(`${cliSettings.apiUrl}/v1/projects/${ref}/config/database/postgres`),
    tokenOpt,
    cliSettings.userAgent,
  );

  const response = yield* httpClient.execute(request).pipe(
    Effect.mapError((cause) =>
      mapTransportMessage(
        cause,
        (description) => `failed to retrieve Postgres config overrides: ${description}`,
        (args) => new PostgresConfigGetNetworkError(args),
      ),
    ),
  );

  if (response.status !== 200) {
    const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const body = sanitizeErrorBody(rawBody);
    return yield* Effect.fail(
      new PostgresConfigGetUnexpectedStatusError({
        status: response.status,
        body,
        message: `unexpected config overrides status ${response.status}: ${body}`,
      }),
    );
  }

  const rawBody = yield* response.text;
  return yield* parseJsonObject(
    rawBody,
    (description) => `failed to unmarshal response body: ${description}`,
    (args) => new PostgresConfigGetUnmarshalError(args),
  );
});

/**
 * Per-operation error wiring for {@link putPostgresConfig}. Both `update` and
 * `delete` issue the same PUT, but tag failures with their own error types and
 * Go-parity message verbs. Passing the constructors and message templates as
 * arguments (mirroring `mapHttpError`) keeps each call site's error
 * channel precise instead of widening it to the union of both operations.
 */
export interface PutPostgresConfigErrors<SerErr, NetErr, StatErr, UnmErr> {
  readonly serializeError: (args: { readonly message: string }) => SerErr;
  readonly networkError: (args: { readonly message: string }) => NetErr;
  readonly statusError: (args: {
    readonly status: number;
    readonly body: string;
    readonly message: string;
  }) => StatErr;
  readonly unmarshalError: (args: { readonly message: string }) => UnmErr;
  readonly networkMessage: (description: string) => string;
  readonly statusMessage: (status: number, body: string) => string;
  readonly unmarshalMessage: (description: string) => string;
}

export const putPostgresConfig = <SerErr, NetErr, StatErr, UnmErr>(
  ref: string,
  config: PostgresConfigMap,
  errors: PutPostgresConfigErrors<SerErr, NetErr, StatErr, UnmErr>,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const cliSettings = yield* CommandSettings;
    const tokenOpt = yield* resolveAccessToken;

    // Use raw HTTP instead of the generated input schema: Go accepts arbitrary
    // config keys from repeated `--config key=value`, while the typed client
    // only models the currently known OpenAPI fields.
    const encodedBody = yield* Effect.try({
      try: () => encodeGoStructJsonBody(config),
      catch: (cause) =>
        errors.serializeError({
          message: `failed to serialize config overrides: ${String(cause)}`,
        }),
    });

    const request = requestWithAuth(
      HttpClientRequest.put(
        `${cliSettings.apiUrl}/v1/projects/${ref}/config/database/postgres`,
      ).pipe(HttpClientRequest.bodyText(encodedBody, "application/json")),
      tokenOpt,
      cliSettings.userAgent,
    );

    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          mapTransportMessage(cause, errors.networkMessage, errors.networkError),
        ),
      );

    if (response.status !== 200) {
      const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const body = sanitizeErrorBody(rawBody);
      return yield* Effect.fail(
        errors.statusError({
          status: response.status,
          body,
          message: errors.statusMessage(response.status, body),
        }),
      );
    }

    const rawBody = yield* response.text;
    return yield* parseJsonObject(rawBody, errors.unmarshalMessage, errors.unmarshalError);
  }).pipe(Effect.withSpan("postgres-config.put"));

export const writePostgresConfigOutput = Effect.fn("postgres-config.write-output")(function* (
  config: PostgresConfigMap,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const goOutput = Option.getOrUndefined(outputFlag);

  // The `--output` flag takes priority over the TS `--output-format` flag.
  // `pretty` (and an unset flag) fall through to the human-readable table /
  // structured-success path below.
  if (goOutput === "json") {
    yield* output.raw(encodeGoJson(config));
    return;
  }
  if (goOutput === "yaml") {
    yield* output.raw(encodeYaml(config));
    return;
  }
  if (goOutput === "toml") {
    yield* output.raw(encodePostgresConfigToml(config));
    return;
  }
  if (goOutput === "env") {
    yield* output.raw(encodeEnv(config) + "\n");
    return;
  }

  if (output.format === "json" || output.format === "stream-json") {
    yield* output.success("", config);
    return;
  }

  yield* output.raw("- Custom Postgres Config -\n", "stderr");
  yield* output.raw(renderPostgresConfigTable(config));
  yield* output.raw("- End of Custom Postgres Config -\n", "stderr");
});
