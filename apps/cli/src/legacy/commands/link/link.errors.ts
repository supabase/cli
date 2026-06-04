import { Data } from "effect";

/** Transport failure while fetching `GET /v1/projects/{ref}`. */
export class LegacyLinkProjectStatusNetworkError extends Data.TaggedError(
  "LegacyLinkProjectStatusNetworkError",
)<{
  readonly message: string;
}> {}

/**
 * `GET /v1/projects/{ref}` returned a non-200, non-404 status. Byte-matches Go's
 * `"Unexpected error retrieving remote project status: " + body` (`link.go:252`).
 */
export class LegacyLinkProjectStatusError extends Data.TaggedError("LegacyLinkProjectStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/**
 * The remote project is paused (`status == INACTIVE`). Message `"project is paused"`
 * with the dashboard unpause suggestion attached, mirroring Go's `errProjectPaused`
 * + `utils.CmdSuggestion` (`link.go:256-258`).
 */
export class LegacyProjectPausedError extends Data.TaggedError("LegacyProjectPausedError")<{
  readonly message: string;
  readonly suggestion: string;
}> {}

/** Transport failure while fetching `GET /v1/projects/{ref}/api-keys`. */
export class LegacyLinkApiKeysNetworkError extends Data.TaggedError(
  "LegacyLinkApiKeysNetworkError",
)<{
  readonly message: string;
}> {}

/**
 * `GET /v1/projects/{ref}/api-keys` returned a non-200 status. Byte-matches Go's
 * `ErrAuthToken` (`"Authorization failed for the access token and project ref pair"`)
 * formatted with the response body (`client.go:78`).
 */
export class LegacyLinkAuthTokenError extends Data.TaggedError("LegacyLinkAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/**
 * The api-keys response contained no usable anon/service-role key. Byte-matches
 * Go's `errMissingKey` (`"Anon key not found."`, `client.go:15`).
 */
export class LegacyLinkMissingKeyError extends Data.TaggedError("LegacyLinkMissingKeyError")<{
  readonly message: string;
}> {}
