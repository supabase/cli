import { Effect } from "effect";
import { InvalidManagedIdentityError } from "./model.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Effect-native UUID validation used by metadata readers and writers. */
export const validateManagedUuid = (
  value: unknown,
  label: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  typeof value === "string" && UUID_PATTERN.test(value)
    ? Effect.succeed(value)
    : Effect.fail(new InvalidManagedIdentityError({ message: `${label} must be an opaque UUID` }));

/** Mint and validate an identity in the Effect error channel. */
export const createManagedUuidEffect = (
  idFactory: () => string,
  label: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Effect.sync(idFactory).pipe(Effect.flatMap((value) => validateManagedUuid(value, label)));
