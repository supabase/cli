import { findUnknownCliConfigKeys } from "@supabase/config/internal";

import { cliConfigDocumentOnlyPaths } from "./cli-config-keys.ts";
import { getDocumentValue, isDocumentRecord } from "./cli-config-document.ts";

const MAX_SUGGESTION_DISTANCE = 2;

/** An unknown key's path in the document and the keys its parent table accepts. */
export interface ReportableUnknownCliConfigKey {
  readonly path: ReadonlyArray<string>;
  readonly knownKeys: ReadonlyArray<string>;
}

const withoutRemote = (key: ReadonlyArray<string>): ReadonlyArray<string> =>
  key[0] === "remotes" ? key.slice(2) : key;

/** Unknown-key reports stop at the first unknown table, so a document-only table such as `auth.passkey` arrives whole. */
const isDocumentOnlyKey = (key: ReadonlyArray<string>): boolean => {
  const dotted = key.join(".");
  return [...cliConfigDocumentOnlyPaths].some(
    (known) => known === dotted || known.startsWith(`${dotted}.`) || dotted.startsWith(`${known}.`),
  );
};

/** Custom `[auth.external.<name>]` providers have no schema entry, but `start` reads them from the raw document. */
const isCustomAuthProvider = (rawDocument: unknown, key: ReadonlyArray<string>): boolean => {
  const local = withoutRemote(key);
  return (
    local.length === 3 &&
    local[0] === "auth" &&
    local[1] === "external" &&
    isDocumentRecord(getDocumentValue(rawDocument, key))
  );
};

const documentOnlySiblings = (key: ReadonlyArray<string>): ReadonlyArray<string> => {
  const parent = withoutRemote(key).slice(0, -1);
  return [...cliConfigDocumentOnlyPaths].flatMap((known) => {
    const segments = known.split(".");
    const sibling = segments[parent.length];
    return sibling !== undefined && parent.every((segment, index) => segments[index] === segment)
      ? [sibling]
      : [];
  });
};

/** Unknown keys the CLI ignores and should flag, minus document-only tables and custom auth providers. */
export function reportableUnknownCliConfigKeys(
  document: unknown,
): ReadonlyArray<ReportableUnknownCliConfigKey> {
  return findUnknownCliConfigKeys(document)
    .filter(
      ({ path }) =>
        !isDocumentOnlyKey(withoutRemote(path)) && !isCustomAuthProvider(document, path),
    )
    .map(({ path, knownKeys }) => ({
      path,
      knownKeys: [...new Set([...knownKeys, ...documentOnlySiblings(path)])],
    }));
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution =
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(
        Math.min(substitution, (previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** The accepted key closest to a misspelled `key` within two edits, or undefined when none or several tie. */
export function suggestCliConfigKey(
  key: string,
  knownKeys: ReadonlyArray<string>,
): string | undefined {
  const scored = knownKeys
    .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
    .filter(({ distance }) => distance <= MAX_SUGGESTION_DISTANCE && distance < key.length);
  const best = Math.min(...scored.map(({ distance }) => distance));
  const closest = scored.filter(({ distance }) => distance === best);
  return closest.length === 1 ? closest[0]?.candidate : undefined;
}
