import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option, Predicate, Schema } from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import {
  encodeGoToml,
  encodeGoYaml,
  goBool,
  goFloat32,
  goNullable,
  goPtr,
  goSlice,
  goString,
  goStruct,
} from "../../../command-internal/go-struct-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
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

/**
 * Type shape for the snippets-list response, used to drive `-o yaml|toml` key
 * casing. `description` (`nullable.Nullable[string]`) renders as
 * `map[bool]string` in YAML and is refused outright in TOML.
 */
const GO_SNIPPET_LIST = goStruct([
  ["cursor", goPtr(goString)],
  [
    "data",
    goSlice(
      goStruct([
        ["description", goNullable(goString)],
        ["favorite", goBool],
        ["id", goString],
        ["inserted_at", goString],
        ["name", goString],
        [
          "owner",
          goStruct([
            ["id", goFloat32],
            ["username", goString],
          ]),
        ],
        [
          "project",
          goStruct([
            ["id", goFloat32],
            ["name", goString],
          ]),
        ],
        ["type", goString],
        ["updated_at", goString],
        [
          "updated_by",
          goStruct([
            ["id", goFloat32],
            ["username", goString],
          ]),
        ],
        ["visibility", goString],
      ]),
    ),
  ],
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  Predicate.isObjectOrArray(value) ? { ...value } : {};

const decodeSnippetsList = Schema.decodeUnknownEffect(
  operationDefinitions.v1ListAllSnippets.outputSchema,
);

const mapListError = mapHttpError({
  networkError: SnippetsListNetworkError,
  statusError: SnippetsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list snippets: ${cause}`,
  statusMessage: (status, body) => `unexpected list snippets status ${status}: ${body}`,
});

export const snippetsList = Effect.fn("snippets.list")(function* (flags: SnippetsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
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
      if (Option.getOrUndefined(goOutputFlag) === "env") {
        return yield* new SnippetsEnvNotSupportedError({
          message: "--output env flag is not supported",
        });
      }

      const fetching =
        output.format === "text" ? yield* output.task("Fetching snippets...") : undefined;
      // `executeRaw` keeps the response body intact so JSON output emits it as the API returned
      // it; the typed schema decodes a copy for rendering.
      const response = yield* api
        .executeRaw(operationDefinitions.v1ListAllSnippets, { project_ref: ref })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.catch(mapListError),
          Effect.tapError(() => fetching?.fail() ?? Effect.void),
        );
      const rawBody = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new SnippetsListNetworkError({
              message: `failed to list snippets: ${String(cause)}`,
              decode: true,
            }),
        ),
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      const parsed = yield* decodeSnippetsList(rawBody).pipe(
        Effect.catch(mapListError),
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
      );
      yield* fetching?.clear ?? Effect.void;

      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "json") {
        // Round-trips the raw body so a real API `data: []` stays `data: []`
        // and a hypothetical `data: null` stays null — nil-vs-empty is
        // preserved rather than normalized.
        yield* output.raw(encodeGoJson(rawBody));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeGoYaml(rawBody, GO_SNIPPET_LIST));
        return;
      }
      if (goFmt === "toml") {
        // The established TOML encoder can't represent the nullable
        // `description` field, so this fails whenever any snippet carries a
        // `description` key — mirroring that established failure exactly.
        const toml = yield* Effect.try({
          try: () => encodeGoToml(rawBody, GO_SNIPPET_LIST),
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

      yield* output.raw(
        renderSnippetsTable(
          parsed.data.map((snippet): SnippetRow => ({
            id: snippet.id,
            name: snippet.name,
            visibility: snippet.visibility,
            owner: { username: snippet.owner?.username ?? "" },
            inserted_at: snippet.inserted_at,
            updated_at: snippet.updated_at,
          })),
        ),
      );
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
