/**
 * The FGA permission set an operation needs for a request detail the API spec does not describe.
 * `reveal=true` on the api-keys call is inferred to need the secret-read permission as well; the
 * unit tests check each set against the operation's sets in the spec.
 */
interface FgaRequestSet {
  readonly operationId: string;
  readonly query: Readonly<Record<string, string>>;
  readonly permissions: ReadonlyArray<string>;
}

export const fgaRequestSets: ReadonlyArray<FgaRequestSet> = [
  {
    operationId: "v1-get-project-api-keys",
    query: { reveal: "true" },
    permissions: ["api_gateway_keys_read", "api_gateway_keys_secret_read"],
  },
];

/** The set an operation needs for `query`, or `undefined` when the spec's own sets apply. */
export function fgaSetForQuery(
  operationId: string,
  query: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<string> | undefined {
  if (query === undefined) return undefined;
  return fgaRequestSets.find(
    (entry) =>
      entry.operationId === operationId &&
      Object.entries(entry.query).every(([key, value]) => query[key] === value),
  )?.permissions;
}
