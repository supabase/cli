import { Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import {
  encodeStructToml,
  encodeStructYaml,
  shapeBool,
  shapeFloat32,
  shapeNullable,
  shapePtr,
  shapeSlice,
  shapeString,
  shapeStruct,
} from "../../../command-internal/struct-output.encoders.ts";
import { resolveAccessToken } from "../../../command-internal/resolve-token.ts";
import { sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  SnippetsEnvNotSupportedError,
  SnippetsListNetworkError,
  SnippetsListUnexpectedStatusError,
  SnippetsTomlEncodeError,
} from "../snippets.errors.ts";
import { renderSnippetsTable, type SnippetRow } from "../snippets.format.ts";
import type { SnippetsListFlags } from "./list.command.ts";

// Tolerant accessors for the API response body. The real `/v1/snippets`
// payload omits optional fields the generated schema declares required, so
// routing through the typed client fails with `SchemaError: Missing key …`.
function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

function asRecord(obj: unknown): Record<string, unknown> {
  return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
}

/**
 * Type shape for the snippets-list response, used to drive `-o yaml|toml` key
 * casing. `description` (`nullable.Nullable[string]`) renders as
 * `map[bool]string` in YAML and is refused outright in TOML.
 */
const SNIPPET_LIST_SHAPE = shapeStruct([
  ["cursor", shapePtr(shapeString)],
  [
    "data",
    shapeSlice(
      shapeStruct([
        ["description", shapeNullable(shapeString)],
        ["favorite", shapeBool],
        ["id", shapeString],
        ["inserted_at", shapeString],
        ["name", shapeString],
        [
          "owner",
          shapeStruct([
            ["id", shapeFloat32],
            ["username", shapeString],
          ]),
        ],
        [
          "project",
          shapeStruct([
            ["id", shapeFloat32],
            ["name", shapeString],
          ]),
        ],
        ["type", shapeString],
        ["updated_at", shapeString],
        [
          "updated_by",
          shapeStruct([
            ["id", shapeFloat32],
            ["username", shapeString],
          ]),
        ],
        ["visibility", shapeString],
      ]),
    ),
  ],
]);

interface SnippetsResponseBody {
  readonly data: ReadonlyArray<unknown>;
}

function parseSnippetsResponse(body: unknown): SnippetsResponseBody {
  const root = asRecord(body);
  const data = Array.isArray(root["data"]) ? root["data"] : [];
  return { data };
}

function toSnippetRow(raw: unknown): SnippetRow {
  const item = asRecord(raw);
  const owner = asRecord(item["owner"]);
  return {
    id: readString(item, "id"),
    name: readString(item, "name"),
    visibility: readString(item, "visibility"),
    owner: { username: readString(owner, "username") },
    inserted_at: readString(item, "inserted_at"),
    updated_at: readString(item, "updated_at"),
  };
}

export const snippetsList = Effect.fn("snippets.list")(function* (flags: SnippetsListFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const httpClient = yield* HttpClient.HttpClient;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Fixed lifecycle every command must preserve:
  //   resolve project ref
  //   reject --output env / call API / render
  //   write linked-project cache (needs `ref`)
  //   flush telemetry (no `ref` required)
  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      if (Option.getOrUndefined(outputFlag) === "env") {
        return yield* new SnippetsEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }

      const tokenOpt = yield* resolveAccessToken;
      const authHeader: (
        req: HttpClientRequest.HttpClientRequest,
      ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
        ? HttpClientRequest.bearerToken(tokenOpt.value)
        : (req) => req;
      const request = HttpClientRequest.get(`${cliSettings.apiUrl}/v1/snippets`).pipe(
        HttpClientRequest.setUrlParams({ project_ref: ref }),
        authHeader,
        HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
      );

      const fetching =
        output.format === "text" ? yield* output.task("Fetching snippets...") : undefined;
      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(
          (cause) =>
            new SnippetsListNetworkError({
              message: `failed to list snippets: ${cause.reason.description ?? cause.reason._tag}`,
            }),
        ),
      );

      if (response.status !== 200) {
        yield* fetching?.fail() ?? Effect.void;
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const body = sanitizeErrorBody(rawBody);
        return yield* new SnippetsListUnexpectedStatusError({
          status: response.status,
          body,
          message: `unexpected list snippets status ${response.status}: ${body}`,
        });
      }

      const rawBody = yield* response.json.pipe(
        Effect.catch(
          (cause) =>
            new SnippetsListNetworkError({
              message: `failed to list snippets: ${String(cause)}`,
              // 200-response body decode failure — an API-response problem, not
              // a transport/network failure.
              decode: true,
            }),
        ),
      );
      yield* fetching?.clear ?? Effect.void;

      const parsed = parseSnippetsResponse(rawBody);
      const outputFlagFormat = Option.getOrUndefined(outputFlag);

      if (outputFlagFormat === "json") {
        // Round-trips the raw body so a real API `data: []` stays `data: []`
        // and a hypothetical `data: null` stays null — nil-vs-empty is
        // preserved rather than normalized.
        yield* output.raw(encodeSortedJson(rawBody));
        return;
      }
      if (outputFlagFormat === "yaml") {
        yield* output.raw(encodeStructYaml(rawBody, SNIPPET_LIST_SHAPE));
        return;
      }
      if (outputFlagFormat === "toml") {
        // The established TOML encoder can't represent the nullable
        // `description` field, so this fails whenever any snippet carries a
        // `description` key — mirroring that established failure exactly.
        const toml = yield* Effect.try({
          try: () => encodeStructToml(rawBody, SNIPPET_LIST_SHAPE),
          catch: (cause) =>
            new SnippetsTomlEncodeError({
              message: `failed to output toml: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        yield* output.raw(toml);
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", asRecord(rawBody));
        return;
      }

      yield* output.raw(renderSnippetsTable(parsed.data.map(toSnippetRow)));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
