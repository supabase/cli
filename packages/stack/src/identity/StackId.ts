import { Schema } from "effect";

declare const StackIdTypeId: unique symbol;

/** A validated, durable identity for a managed stack. */
export type StackId = string & { readonly [StackIdTypeId]: "StackId" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const isStackId = (value: string): value is StackId => SHA256_HEX.test(value);

export const StackIdSchema = Schema.String.pipe(
  Schema.refine((value): value is StackId => isStackId(value), {
    identifier: "StackId",
    message: "Expected a lowercase SHA-256 hexadecimal stack id",
  }),
);
