import { operationPermissions } from "@supabase/api/permissions";

import { fgaSetForQuery } from "./fga-request-sets.ts";
import type { OperationEntry } from "./model.ts";

type PermissionKind = OperationEntry["kind"];

/** The alternatives for one operation: a token needs every permission in at least one of them. */
export type Alternatives = ReadonlyArray<ReadonlyArray<string>>;

/** One way of expressing what a token needs: FGA permissions, OAuth scopes, and so on. */
export interface PermissionScheme {
  readonly id: string;
  readonly title: string;
  /** The alternatives for an operation, or `undefined` when the scheme lists none. */
  readonly requirement: (
    operationId: string,
    request: OperationEntry["request"],
  ) => Alternatives | undefined;
  /** What to say about an operation for which {@link requirement} is `undefined`. */
  readonly missing: (kind: PermissionKind, operationId: string) => string;
}

const NO_LISTING = "no token permission listed in the API spec";

const isSubset = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.every((permission) => b.includes(permission));

/** Drops any set that another set already covers, since a token holding the smaller set suffices. */
function withoutSupersets(sets: Alternatives): Alternatives {
  return sets.filter(
    (set, index) =>
      !sets.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          isSubset(other, set) &&
          (!isSubset(set, other) || otherIndex < index),
      ),
  );
}

export const fgaScheme: PermissionScheme = {
  id: "fga",
  title: "Personal access token (FGA)",
  requirement: (operationId, request) => {
    const forRequest = fgaSetForQuery(operationId, request?.query);
    if (forRequest !== undefined) return [forRequest];
    const sets = operationPermissions[operationId]?.fga ?? [];
    return sets.length === 0 ? undefined : withoutSupersets(sets);
  },
  missing: () => NO_LISTING,
};

/** Not in {@link permissionSchemes} while OAuth scopes stay out of help. */
export const oauthScheme: PermissionScheme = {
  id: "oauth",
  title: "OAuth token (scopes)",
  requirement: (operationId) => {
    const scope = operationPermissions[operationId]?.oauthScope;
    return scope === undefined ? undefined : [[scope]];
  },
  missing: (kind, operationId) => {
    if ((operationPermissions[operationId]?.fga.length ?? 0) === 0) return NO_LISTING;
    return kind === "required"
      ? "not available with OAuth tokens yet"
      : "skipped with OAuth tokens (not available yet)";
  },
};

/** Add a scheme here to show it in every command's help. */
export const permissionSchemes: ReadonlyArray<PermissionScheme> = [fgaScheme];
