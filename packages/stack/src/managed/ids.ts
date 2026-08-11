import { InvalidManagedIdentityError } from "./model.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const assertManagedUuid = (value: string, label: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidManagedIdentityError(`${label} must be an opaque UUID`);
  }
  return value;
};

export const createManagedUuid = (idFactory: () => string, label: string): string =>
  assertManagedUuid(idFactory(), label);
