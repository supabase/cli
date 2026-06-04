import { Data } from "effect";

// ---------------------------------------------------------------------------
// HTTP-bound errors — one (Network + UnexpectedStatus) pair per Go errorf site.
// Names trace back to `apps/cli-go/internal/projects/<sub>/` for grepability.
// Templates match Go's `errors.Errorf(...)` phrasing byte-for-byte.
// ---------------------------------------------------------------------------

export class LegacyProjectsListNetworkError extends Data.TaggedError(
  "LegacyProjectsListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyProjectsCreateNetworkError extends Data.TaggedError(
  "LegacyProjectsCreateNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsCreateUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// Interactive org list fetched by `create` when `--org-id` is omitted
// (`create.go:97-105`).
export class LegacyProjectsOrgsListNetworkError extends Data.TaggedError(
  "LegacyProjectsOrgsListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsOrgsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsOrgsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyProjectsDeleteNetworkError extends Data.TaggedError(
  "LegacyProjectsDeleteNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// 404 branch of `delete.Run` (`delete.go:37-38`): "Project does not exist:<ref>".
export class LegacyProjectsDeleteNotFoundError extends Data.TaggedError(
  "LegacyProjectsDeleteNotFoundError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsApiKeysNetworkError extends Data.TaggedError(
  "LegacyProjectsApiKeysNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyProjectsApiKeysUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsApiKeysUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Pure-path errors (validation, prompt-time semantics, user cancellation).
// ---------------------------------------------------------------------------

// `list` rejects Go's `--output env` (`list.go:66-67`, `utils.ErrEnvNotSupported`).
export class LegacyProjectsEnvNotSupportedError extends Data.TaggedError(
  "LegacyProjectsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

// Non-interactive `create` missing required params — mirrors Go's PreRunE
// marking `--org-id`, `--db-password`, `--region` required + ExactArgs(1)
// (`projects.go:62-69`).
export class LegacyProjectsCreateMissingArgError extends Data.TaggedError(
  "LegacyProjectsCreateMissingArgError",
)<{
  readonly message: string;
}> {}

// Interactive `create` name prompt returned blank (`create.go:94`).
export class LegacyProjectsCreateNameEmptyError extends Data.TaggedError(
  "LegacyProjectsCreateNameEmptyError",
)<{
  readonly message: string;
}> {}

// `delete` non-interactive with no positional ref — mirrors Go's
// `cobra.ExactArgs(1)` on a non-TTY (`projects.go:109-113`).
export class LegacyProjectsDeleteRefRequiredError extends Data.TaggedError(
  "LegacyProjectsDeleteRefRequiredError",
)<{
  readonly message: string;
}> {}

// User declined the delete confirmation prompt (`delete.go:24-25`,
// `errors.New(context.Canceled)`).
export class LegacyProjectsDeleteCancelledError extends Data.TaggedError(
  "LegacyProjectsDeleteCancelledError",
)<{
  readonly message: string;
}> {}
