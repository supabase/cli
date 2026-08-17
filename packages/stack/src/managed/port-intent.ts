import { PORT_CATALOG } from "../PortCatalog.ts";
import type { ManagedPortIntentDocument, ManagedPortRequest } from "./model.ts";

export type { ManagedPortIntentDocument, ManagedPortRequest } from "./model.ts";

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const valueAt = (
  document: Readonly<Record<string, unknown>> | undefined,
  path: ReadonlyArray<string>,
): unknown => {
  let current: unknown = document;
  for (const segment of path) {
    if (!isRecord(current) || !hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

/** Resolve configured sticky port keys from the pre-default effective document. */
export const resolvePortIntents = (
  document: ManagedPortIntentDocument,
): ReadonlyArray<ManagedPortRequest> =>
  document.activeFields.flatMap((field): ReadonlyArray<ManagedPortRequest> => {
    const entry = PORT_CATALOG[field];
    if (entry.persistence !== "sticky" || entry.configKey === undefined) {
      return [];
    }

    const path = entry.configKey.split(".");
    const value = valueAt(document.document, path);
    if (typeof value === "number") {
      return [
        {
          field,
          key: entry.configKey,
          intent: "exact",
          port: value,
        },
      ];
    }

    return [{ field, key: entry.configKey, intent: "automatic" }];
  });
