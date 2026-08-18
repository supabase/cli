import { assertManagedUuid } from "./ids.ts";
import {
  GIT_CHECKOUT_IDENTITY_VERSION,
  InvalidManagedIdentityError,
  type GitCheckoutIdentity,
} from "./model.ts";

/** Internal versioned decoder shared by every Git checkout marker read path. */
export const decodeGitCheckoutIdentity = (content: string): GitCheckoutIdentity => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new InvalidManagedIdentityError({
      message: `The git checkout identity is not JSON: ${cause}`,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new InvalidManagedIdentityError({
      message: "The git checkout identity must be an object",
    });
  }
  const version = Reflect.get(value, "version");
  if (version !== GIT_CHECKOUT_IDENTITY_VERSION) {
    throw new InvalidManagedIdentityError({
      message: `Unsupported git checkout identity version ${String(version)}`,
    });
  }
  const checkoutId = Reflect.get(value, "checkoutId");
  if (typeof checkoutId !== "string") {
    throw new InvalidManagedIdentityError({ message: "checkoutId must be an opaque UUID" });
  }
  return { version, checkoutId: assertManagedUuid(checkoutId, "checkoutId") };
};
