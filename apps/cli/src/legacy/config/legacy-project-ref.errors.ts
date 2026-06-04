import { Data } from "effect";

export class LegacyProjectNotLinkedError extends Data.TaggedError("LegacyProjectNotLinkedError")<{
  readonly message: string;
}> {}

export class LegacyInvalidProjectRefError extends Data.TaggedError("LegacyInvalidProjectRefError")<{
  readonly ref: string;
  readonly message: string;
}> {}

/**
 * Raised by `resolveForLink` on a non-TTY when neither `--project-ref` nor
 * `SUPABASE_PROJECT_ID` is set. Byte-matches cobra's required-flag error string
 * (`required flag(s) "project-ref" not set`) that `supabase link`'s `PreRunE`
 * produces via `cmd.MarkFlagRequired("project-ref")`.
 */
export class LegacyProjectRefRequiredError extends Data.TaggedError(
  "LegacyProjectRefRequiredError",
)<{
  readonly message: string;
}> {}
