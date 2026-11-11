import { Schema } from "effect";

/** An identifier safe to use as a single path segment: letters, digits, `_` and `-`. */
export const SafeId = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-zA-Z0-9_-]+$/u.test(value), {
    identifier: "SafeId",
    message: "Expected a safe id",
  }),
);

export const isSafeId = Schema.is(SafeId);
