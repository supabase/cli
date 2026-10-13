import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option, Schema, SchemaIssue } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../output/glamour-table.ts";
import { encodeEnv, encodeGoJson, encodeYaml } from "../../command-internal/go-output.encoders.ts";
import { goFormatFloat } from "../../command-internal/go-float.ts";
import {
  mapHttpError,
  sanitizeErrorBody,
  type NetworkErrorFactory,
  type StatusErrorFactory,
} from "../../command-internal/http-errors.ts";
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

const decodeJsonObject = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const getStatusMessage = (status: number, body: string) =>
  `unexpected config overrides status ${status}: ${body}`;

const mapGetError = mapHttpError({
  networkError: PostgresConfigGetNetworkError,
  statusError: PostgresConfigGetUnexpectedStatusError,
  networkMessage: (description) => `failed to retrieve Postgres config overrides: ${description}`,
  statusMessage: getStatusMessage,
});

/**
 * Reads the stored overrides as the platform returned them. Read-modify-write callers must see
 * every stored key, so the response is not decoded against the typed output schema.
 */
export const fetchCurrentPostgresConfig = Effect.fn("postgres-config.fetch-current")(function* (
  ref: string,
) {
  const api = yield* CommandPlatformApi;

  const response = yield* api
    .executeRaw(operationDefinitions.v1GetPostgresConfig, { ref })
    .pipe(Effect.catch(mapGetError));

  const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  if (response.status !== 200) {
    const body = sanitizeErrorBody(rawBody);
    return yield* new PostgresConfigGetUnexpectedStatusError({
      status: response.status,
      body,
      message: getStatusMessage(response.status, body),
    });
  }

  const stored = yield* decodeJsonObject(rawBody).pipe(
    Effect.mapError(
      (error) =>
        new PostgresConfigGetUnmarshalError({
          message: `failed to unmarshal response body: ${error.message}`,
        }),
    ),
  );
  return { ...stored } satisfies PostgresConfigMap;
});

const updateOperation = operationDefinitions.v1UpdatePostgresConfig;
const decodeUpdateInput = Schema.decodeUnknownEffect(updateOperation.inputSchema);

interface ConfigProblems {
  readonly unknownKeys: Array<string>;
  readonly invalidValues: Array<string>;
}

function collectConfigProblems(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  problems: ConfigProblems,
): void {
  switch (issue._tag) {
    case "Composite":
      for (const nested of issue.issues) collectConfigProblems(nested, path, problems);
      return;
    case "Pointer":
      collectConfigProblems(issue.issue, [...path, ...issue.path], problems);
      return;
    case "UnexpectedKey":
      problems.unknownKeys.push(path.map(String).join("."));
      return;
    default:
      problems.invalidValues.push(
        `${path.map(String).join(".")}: ${SchemaIssue.makeFormatterDefault()(issue)}`,
      );
  }
}

function describeConfigProblems(issue: SchemaIssue.Issue) {
  const problems: ConfigProblems = { unknownKeys: [], invalidValues: [] };
  collectConfigProblems(issue, [], problems);
  const messages: Array<string> = [];
  if (problems.unknownKeys.length > 0) {
    const noun = problems.unknownKeys.length === 1 ? "parameter" : "parameters";
    messages.push(`unknown Postgres config ${noun}: ${problems.unknownKeys.join(", ")}`);
  }
  for (const invalid of problems.invalidValues) {
    messages.push(`invalid Postgres config value for ${invalid}`);
  }
  return messages.join("; ");
}

/**
 * Per-operation error wiring for {@link putPostgresConfig}. Both `update` and `delete` issue
 * the same PUT but tag failures with their own error types and message verbs.
 */
export interface PutPostgresConfigErrors<SerErr, NetErr, StatErr> {
  readonly serializeError: (args: { readonly message: string }) => SerErr;
  readonly networkError: NetworkErrorFactory<NetErr>;
  readonly statusError: StatusErrorFactory<StatErr>;
  readonly networkMessage: (description: string) => string;
  readonly statusMessage: (status: number, body: string) => string;
}

/**
 * PUTs the full overrides map. The request is validated against the typed input first so a
 * mistyped parameter or an unsupported stored key fails here, naming the key, instead of as an
 * opaque 400.
 */
export const putPostgresConfig = Effect.fn("postgres-config.put")(function* <
  SerErr,
  NetErr,
  StatErr,
>(
  ref: string,
  config: PostgresConfigMap,
  errors: PutPostgresConfigErrors<SerErr, NetErr, StatErr>,
) {
  const api = yield* CommandPlatformApi;

  const input = yield* decodeUpdateInput(
    { ...config, ref },
    { onExcessProperty: "error", errors: "all" },
  ).pipe(
    Effect.mapError((error) =>
      errors.serializeError({ message: describeConfigProblems(error.issue) }),
    ),
  );

  return yield* api.v1.updatePostgresConfig(input).pipe(Effect.catch(mapHttpError(errors)));
});

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
