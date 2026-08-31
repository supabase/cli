import { Effect, Schema } from "effect";
import { validateManagedUuid } from "./ids.ts";
import {
  GIT_CHECKOUT_IDENTITY_VERSION,
  InvalidManagedIdentityError,
  type GitCheckoutIdentity,
} from "./model.ts";

const gitCheckoutIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(GIT_CHECKOUT_IDENTITY_VERSION),
    checkoutId: Schema.String,
  }),
);

/** Internal versioned encoder shared by every Git checkout marker write path. */
export const encodeGitCheckoutIdentity = (
  identity: GitCheckoutIdentity,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Schema.encodeEffect(gitCheckoutIdentitySchema)(identity).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The git checkout identity is invalid: ${String(error)}`,
        }),
    ),
  );

/** Internal versioned decoder shared by every Git checkout marker read path. */
export const decodeGitCheckoutIdentity = (
  content: string,
): Effect.Effect<GitCheckoutIdentity, InvalidManagedIdentityError> =>
  Schema.decodeEffect(gitCheckoutIdentitySchema)(content).pipe(
    Effect.mapError(
      (error) =>
        new InvalidManagedIdentityError({
          message: `The git checkout identity is invalid: ${String(error)}`,
        }),
    ),
    Effect.flatMap(({ version, checkoutId }) =>
      validateManagedUuid(checkoutId, "checkoutId").pipe(
        Effect.map((validated) => ({ version, checkoutId: validated })),
      ),
    ),
  );
