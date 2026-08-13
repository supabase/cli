/**
 * The `code` carried by Node's filesystem/process errors and by the SQLite
 * drivers. Reading it structurally keeps the managed layer free of driver
 * imports and of message-text matching.
 */
export const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
};
