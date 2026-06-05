import type { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { Effect } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
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
 * `GET /v1/projects/{ref}/api-keys` with no `reveal` param, mapping transport /
 * non-200 failures to the same `failed to get api keys` / `unexpected get api keys
 * status` errors Go raises. Shared by `projects api-keys` (display) and `bootstrap`
 * (which derives the `.env` keys).
 */
export const legacyGetProjectApiKeys = Effect.fnUntraced(function* (ref: string) {
  const api = yield* LegacyPlatformApi;
  const keys: ApiKeys = yield* api.v1
    .getProjectApiKeys({ ref })
    .pipe(Effect.catch(mapApiKeysError));
  return keys;
});
