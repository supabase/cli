import { Effect, Schema, SchemaIssue } from "effect";

// Both boundaries accept any parsed JSON value; consumers own domain narrowing.
const decodeJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Unknown, { preserveNativeError: true }),
);

function originalJsonError(error: Schema.SchemaError): Error {
  let issue = error.issue;
  while (issue instanceof SchemaIssue.Encoding) issue = issue.issue;
  if (issue instanceof SchemaIssue.InvalidValue) {
    const cause = issue.annotations?.["supabase/nativeJsonError"];
    if (cause instanceof Error) return cause;
  }
  return error;
}

/** Uses the schema codec while retaining native JSON parse errors via the pinned Effect patch. */
export const decodeSsoJson = (input: string) =>
  Effect.mapError(decodeJson(input), originalJsonError);

export const quoteSsoString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
