import { Data } from "effect";

// ---------------------------------------------------------------------------
// HTTP-bound errors — one (Network + UnexpectedStatus) pair per Go errorf site.
// Names trace back to `apps/cli-go/internal/branches/<sub>/` for grepability.
// Templates match Go's `errors.Errorf(...)` phrasing byte-for-byte.
// ---------------------------------------------------------------------------

export class LegacyBranchesListNetworkError extends Data.TaggedError(
  "LegacyBranchesListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesListUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesCreateNetworkError extends Data.TaggedError(
  "LegacyBranchesCreateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesCreateUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// Lookup phase of `branches get` (only runs when input is not UUID / not ref).
export class LegacyBranchesFindNetworkError extends Data.TaggedError(
  "LegacyBranchesFindNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesFindUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesFindUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// `branches get` detail phase + the resolver's UUID branch (both use
// V1GetABranchConfig; Go shares the same error template).
export class LegacyBranchesGetNetworkError extends Data.TaggedError(
  "LegacyBranchesGetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesApiKeysNetworkError extends Data.TaggedError(
  "LegacyBranchesApiKeysNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesApiKeysUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesApiKeysUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesPoolerNetworkError extends Data.TaggedError(
  "LegacyBranchesPoolerNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesPoolerUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesPoolerUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesPrimaryNotFoundError extends Data.TaggedError(
  "LegacyBranchesPrimaryNotFoundError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesUpdateNetworkError extends Data.TaggedError(
  "LegacyBranchesUpdateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesPauseNetworkError extends Data.TaggedError(
  "LegacyBranchesPauseNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesPauseUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesPauseUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesUnpauseNetworkError extends Data.TaggedError(
  "LegacyBranchesUnpauseNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesUnpauseUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesUnpauseUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesDeleteNetworkError extends Data.TaggedError(
  "LegacyBranchesDeleteNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBranchesDisableNetworkError extends Data.TaggedError(
  "LegacyBranchesDisableNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesDisableUnexpectedStatusError extends Data.TaggedError(
  "LegacyBranchesDisableUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Pure-path errors (validation, prompt-time semantics, user cancellation).
// ---------------------------------------------------------------------------

export class LegacyBranchesEnvNotSupportedError extends Data.TaggedError(
  "LegacyBranchesEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesCreateCancelledError extends Data.TaggedError(
  "LegacyBranchesCreateCancelledError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesBranchNameEmptyError extends Data.TaggedError(
  "LegacyBranchesBranchNameEmptyError",
)<{
  readonly message: string;
}> {}

export class LegacyBranchesBranchingDisabledError extends Data.TaggedError(
  "LegacyBranchesBranchingDisabledError",
)<{
  readonly message: string;
  /**
   * Mirrors Go's `utils.CmdSuggestion = "Create your first branch with: supabase
   * branches create"` (`apps/cli-go/cmd/branches.go:252`). Picked up by
   * `normalizeCliError` and printed after the error message in text mode.
   */
  readonly suggestion: string;
}> {}
