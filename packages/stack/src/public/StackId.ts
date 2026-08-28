import { Schema } from "effect";

declare const StackIdTypeId: unique symbol;

/** A validated, durable identity for a managed stack. */
export type StackId = string & { readonly [StackIdTypeId]: "StackId" };

export const StackIdSchema = Schema.NonEmptyString.pipe(
  Schema.refine((value): value is StackId => value.length > 0, {
    identifier: "StackId",
    message: "Expected a non-empty stack id",
  }),
);
