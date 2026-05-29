import { Data } from "effect";

// ---------------------------------------------------------------------------
// HTTP-bound errors — one (Network + UnexpectedStatus) pair per Go errorf site
// under `apps/cli-go/internal/orgs/`. Templates byte-match Go's `errors.Errorf`.
// ---------------------------------------------------------------------------

export class LegacyOrgsListNetworkError extends Data.TaggedError("LegacyOrgsListNetworkError")<{
  readonly message: string;
}> {}

export class LegacyOrgsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyOrgsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyOrgsCreateNetworkError extends Data.TaggedError("LegacyOrgsCreateNetworkError")<{
  readonly message: string;
}> {}

export class LegacyOrgsCreateUnexpectedStatusError extends Data.TaggedError(
  "LegacyOrgsCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Pure-path error — `orgs list --output env` is explicitly rejected by the Go
// CLI (`apps/cli-go/internal/orgs/list/list.go:32-33`). `orgs create` does NOT
// have an equivalent branch — the Go `EncodeOutput` env encoder happily
// flattens the single object into `ID=… NAME=… SLUG=…`.
// ---------------------------------------------------------------------------

export class LegacyOrgsEnvNotSupportedError extends Data.TaggedError(
  "LegacyOrgsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}
