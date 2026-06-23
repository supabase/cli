import type { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import {
  LegacyProjectsApiKeysNetworkError,
  LegacyProjectsApiKeysUnexpectedStatusError,
} from "../commands/projects/projects.errors.ts";
import { mapLegacyHttpError } from "./legacy-http-errors.ts";

type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;

const mapApiKeysError = mapLegacyHttpError({
  networkError: LegacyProjectsApiKeysNetworkError,
  statusError: LegacyProjectsApiKeysUnexpectedStatusError,
  networkMessage: (cause) => `failed to get api keys: ${cause}`,
  statusMessage: (status, body) => `unexpected get api keys status ${status}: ${body}`,
});

/**
 * Ports Go's `apiKeys.RunGetApiKeys` (`apps/cli-go/internal/projects/apiKeys/api_keys.go:41-49`):
 * `GET /v1/projects/{ref}/api-keys`, mapping transport / non-200 failures to the same
 * `failed to get api keys` / `unexpected get api keys status` errors Go raises. Shared by
 * `projects api-keys` (display) and `bootstrap` (which derives the `.env` keys).
 *
 * When `reveal` is `true`, the `reveal=true` query param is sent so the Management API
 * returns the full secret keys (prefix `sb_secret_`) in `api_key` instead of `null`
 * (issue #4775). The param is omitted entirely when `reveal` is `false` to keep the
 * default request byte-identical to Go's (`bootstrap` only consumes the never-redacted
 * anon key, so it stays on the default path).
 *
 * Resolves the client lazily via `LegacyPlatformApiFactory.make` so callers on the local
 * path (no `--linked`) never trigger Management API auth. The factory is memoised, so
 * repeated calls in the same command invocation reuse the same client.
 */
export const legacyGetProjectApiKeys = Effect.fnUntraced(function* (ref: string, reveal = false) {
  const api = yield* (yield* LegacyPlatformApiFactory).make;
  const keys: ApiKeys = yield* api.v1
    .getProjectApiKeys(reveal ? { ref, reveal: true } : { ref })
    .pipe(Effect.catch(mapApiKeysError));
  return keys;
});
