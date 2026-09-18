import { Effect, Schema, SchemaIssue } from "effect";

// Both boundaries historically accept any parsed JSON value. Domain narrowing
// belongs to the consumer; validating a tighter shape here would change behavior.
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
