import { Schema } from "effect";

/** A failure from any namespace operation; `operation` names the step that failed. */
export class NamespaceError extends Schema.TaggedError<NamespaceError>()(
  "Namespace.NamespaceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const namespaceError = (operation: string, cause: unknown): NamespaceError =>
  new NamespaceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
