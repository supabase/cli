/**
 * CLI-side corrections to the API spec's FGA permissions, for operations the API enforces
 * differently from what the spec's sets suggest. The spec lists a plain "any one of these sets"
 * and carries no marker for a set that is only needed for one kind of request, for a set that
 * is always needed alongside another, or for a choice that depends on the resource addressed.
 */

import type { RequestDetails } from "./model.ts";

/** The set an operation needs for a request carrying `request`, in place of the spec's sets. */
interface RequestSet {
  readonly operationId: string;
  readonly request: RequestDetails;
  readonly permissions: ReadonlyArray<string>;
}

/**
 * The spec lists the secret-read set for the api-keys operation but not which request needs it;
 * `reveal=true`, which returns full secret keys, is taken to be that request. Creating a branch
 * with data needs the production permission.
 */
export const fgaRequestSets: ReadonlyArray<RequestSet> = [
  {
    operationId: "v1-get-project-api-keys",
    request: { query: { reveal: "true" } },
    permissions: ["api_gateway_keys_read", "api_gateway_keys_secret_read"],
  },
  {
    operationId: "v1-create-a-branch",
    request: { body: { with_data: "true" } },
    permissions: ["branching_production_create"],
  },
];

/**
 * An operation that always needs `required` and, for requests that may write, also `extra`; without
 * `extra` the request still runs, with reduced privileges.
 */
interface ConditionalExtra {
  readonly operationId: string;
  readonly required: ReadonlyArray<string>;
  readonly extra: ReadonlyArray<string>;
}

export const fgaConditionalExtras: ReadonlyArray<ConditionalExtra> = [
  {
    operationId: "v1-run-a-query",
    required: ["database_read"],
    extra: ["database_write"],
  },
];

/** What a request addressing one kind of resource needs; `for` names that resource. */
interface ResourceCase {
  readonly for: string;
  readonly allOf: ReadonlyArray<string>;
}

interface ResourceCases {
  readonly operationId: string;
  readonly cases: ReadonlyArray<ResourceCase>;
}

const branchCases = (action: string): ReadonlyArray<ResourceCase> => [
  { for: "a preview branch", allOf: [`branching_development_${action}`] },
  { for: "the main branch", allOf: [`branching_production_${action}`] },
];

/** A branch addressed by id needs the production permission only when it is the project's main branch. */
export const fgaResourceCases: ReadonlyArray<ResourceCases> = [
  { operationId: "v1-get-a-branch", cases: branchCases("read") },
  { operationId: "v1-get-a-branch-config", cases: branchCases("read") },
  { operationId: "v1-update-a-branch-config", cases: branchCases("write") },
  { operationId: "v1-delete-a-branch", cases: branchCases("delete") },
];

/**
 * What to say about an operation for which the spec lists no FGA set. The profile endpoint rejects
 * project- and organization-scoped tokens.
 */
export const fgaOperationNotes: ReadonlyMap<string, string> = new Map([
  ["v1-get-profile", "a user-scoped token (project- and organization-scoped tokens are rejected)"],
]);

const matches = (
  expected: Readonly<Record<string, string>> | undefined,
  sent: Readonly<Record<string, string>> | undefined,
) => Object.entries(expected ?? {}).every(([key, value]) => sent?.[key] === value);

/** The set an operation needs for `request`, or `undefined` when no correction applies to it. */
export function fgaSetForRequest(
  operationId: string,
  request: RequestDetails | undefined,
): ReadonlyArray<string> | undefined {
  if (request === undefined) return undefined;
  return fgaRequestSets.find(
    (entry) =>
      entry.operationId === operationId &&
      matches(entry.request.query, request.query) &&
      matches(entry.request.body, request.body),
  )?.permissions;
}
