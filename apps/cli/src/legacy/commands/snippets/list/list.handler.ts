import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
  legacyGoBool,
  legacyGoFloat32,
  legacyGoNullable,
  legacyGoPtr,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacySnippetsEnvNotSupportedError,
  LegacySnippetsListNetworkError,
  LegacySnippetsListUnexpectedStatusError,
  LegacySnippetsTomlEncodeError,
} from "../snippets.errors.ts";
import { renderSnippetsTable, type SnippetRow } from "../snippets.format.ts";
import type { LegacySnippetsListFlags } from "./list.command.ts";

// Tolerant accessors for the API response body. The real `/v1/snippets`
// payload regularly omits optional fields like `description` that the
// generated `V1ListAllSnippetsOutput` schema declares as `Union[String, Null]`
// (present-but-nullable). Routing through the typed client therefore fails
// with a `SchemaError: Missing key …` on any real-world response — see the
// cli-e2e `snippets-download-prints-sql-content-to-stdout` failure that
// prompted the bypass. Same workaround pattern as
// `legacy-linked-project-cache.layer.ts` and `legacySuggestUpgrade`.
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
 * Mirror of Go's `api.SnippetList` (`apps/cli-go/pkg/api/types.gen.go`). The
 * `description` field is a `nullable.Nullable[string]` — yaml.v3 renders it as
 * a `map[bool]string`, and BurntSushi refuses it whenever present (CLI-1975).
 */
const LEGACY_GO_SNIPPET_LIST = legacyGoStruct([
  ["cursor", legacyGoPtr(legacyGoString)],
  [
    "data",
    legacyGoSlice(
      legacyGoStruct([
        ["description", legacyGoNullable(legacyGoString)],
        ["favorite", legacyGoBool],
        ["id", legacyGoString],
        ["inserted_at", legacyGoString],
        ["name", legacyGoString],
        [
          "owner",
          legacyGoStruct([
            ["id", legacyGoFloat32],
            ["username", legacyGoString],
          ]),
        ],
        [
          "project",
          legacyGoStruct([
            ["id", legacyGoFloat32],
            ["name", legacyGoString],
          ]),
        ],
        ["type", legacyGoString],
        ["updated_at", legacyGoString],
        [
          "updated_by",
          legacyGoStruct([
            ["id", legacyGoFloat32],
            ["username", legacyGoString],
          ]),
        ],
        ["visibility", legacyGoString],
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

export const legacySnippetsList = Effect.fn("legacy.snippets.list")(function* (
  flags: LegacySnippetsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const httpClient = yield* HttpClient.HttpClient;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Mirror Go's lifecycle (apps/cli-go/cmd/root.go:93-167 + 175-183):
  //   PersistentPreRunE → resolve project ref
  //   Run               → reject --output env / call API / render
  //   PersistentPostRun → write linked-project cache (needs `ref`)
  //   Execute           → flush telemetry (no `ref` required)
  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      if (Option.getOrUndefined(goOutputFlag) === "env") {
        return yield* new LegacySnippetsEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }

      const tokenOpt = yield* resolveLegacyAccessToken;
      const authHeader: (
        req: HttpClientRequest.HttpClientRequest,
      ) => HttpClientRequest.HttpClientRequest = Option.isSome(tokenOpt)
        ? HttpClientRequest.bearerToken(tokenOpt.value)
        : (req) => req;
      const request = HttpClientRequest.get(`${cliConfig.apiUrl}/v1/snippets`).pipe(
        HttpClientRequest.setUrlParams({ project_ref: ref }),
        authHeader,
        HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
      );

      const fetching =
        output.format === "text" ? yield* output.task("Fetching snippets...") : undefined;
      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(
          (cause) =>
            new LegacySnippetsListNetworkError({
              message: `failed to list snippets: ${cause.reason.description ?? cause.reason._tag}`,
            }),
        ),
      );

      if (response.status !== 200) {
        yield* fetching?.fail() ?? Effect.void;
        const rawBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const body = sanitizeLegacyErrorBody(rawBody);
        return yield* new LegacySnippetsListUnexpectedStatusError({
          status: response.status,
          body,
          message: `unexpected list snippets status ${response.status}: ${body}`,
        });
      }

      const rawBody = yield* response.json.pipe(
        Effect.catch(
          (cause) =>
            new LegacySnippetsListNetworkError({
              message: `failed to list snippets: ${String(cause)}`,
              // 200-response body decode failure — an API-response problem, not
              // a transport/network failure.
              decode: true,
            }),
        ),
      );
      yield* fetching?.clear() ?? Effect.void;

      const parsed = parseSnippetsResponse(rawBody);
      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        // Round-trip the raw body so a real API `data: []` stays `data: []`
        // (and a hypothetical `data: null` would stay null). Go's
        // `encoding/json` preserves nil-vs-empty; bypassing the typed client
        // means we can faithfully mirror that here too.
        yield* output.raw(encodeGoJson(rawBody));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeLegacyGoYaml(rawBody, LEGACY_GO_SNIPPET_LIST));
        return;
      }
      if (goFmt === "toml") {
        // BurntSushi cannot encode the `nullable.Nullable[string]` description
        // field (`map[bool]string`), so Go fails whenever any snippet carries a
        // `description` key. Mirror the failure byte-for-byte.
        const toml = yield* Effect.try({
          try: () => encodeLegacyGoToml(rawBody, LEGACY_GO_SNIPPET_LIST),
          catch: (cause) =>
            new LegacySnippetsTomlEncodeError({
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
