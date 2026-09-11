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
  // Every number renders using float64 formatting, matching established output, so e.g.
  // 1000000 prints as 1e+06, not 1000000.
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
    // Every number renders as a float64, so an integral value gets a `.0` suffix (e.g.
    // `max_connections = 100.0`); the shared encodeToml (smol-toml) would emit `100`
    // instead, breaking established output.
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  if (value === null) return JSON.stringify("<nil>");
  return JSON.stringify(JSON.stringify(value));
}

// See encodeTomlScalar: this can't delegate to the shared encodeToml without breaking output.
function encodePostgresConfigToml(config: PostgresConfigMap): string {
  const lines = sortConfigEntries(config).map(
    ([key, value]) => `${key} = ${encodeTomlScalar(value)}`,
  );
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

// Parses config values as 64-bit integers.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// The literal sets that count as boolean values. `1`/`0` also match, but the integer branch
// above claims them first.
const GO_TRUE_LITERALS = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_FALSE_LITERALS = new Set(["0", "f", "F", "FALSE", "false", "False"]);

/**
 * Coerces a `--config key=value` value: integer, then boolean, then string.
 *
 * An integer outside the 64-bit range falls through to the string; boolean matching is
 * case-sensitive over a fixed literal set (`tRuE` stays a string). Integers between `2^53`
 * and `2^63` still lose precision here, since the JSON encoder is `JSON.stringify`, which
 * can't emit exact integers beyond `Number.MAX_SAFE_INTEGER`.
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
 * Per-operation error wiring for {@link putPostgresConfig}. Both `update` and `delete` issue
 * the same PUT but tag failures with their own error types and message verbs (mirroring
 * `mapHttpError`), keeping each call site's error channel precise.
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

    // Uses raw HTTP instead of the generated input schema, since --config accepts arbitrary
    // keys the typed client's OpenAPI-modeled fields don't cover.
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

  // --output takes priority over --output-format; pretty (or unset) falls through to the
  // table / structured-success path below.
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
