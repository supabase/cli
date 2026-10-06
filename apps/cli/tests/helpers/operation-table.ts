import openApiSpec from "@supabase/api/openapi.json";

/**
 * Builds a spec-backed operation table and a request matcher for permission-drift tests. Reads
 * the full spec at test time only — never imported from `src/`, so it never reaches the shipped
 * CLI bundle.
 */

export interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  /** `x-fga-permissions`: any one of these sets satisfies the check; every id in a set is required. */
  readonly fga: ReadonlyArray<ReadonlyArray<string>>;
  /** `x-oauth-scope`, e.g. `"secrets:read"`; `undefined` when the spec declares none. */
  readonly oauthScope: string | undefined;
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly "x-fga-permissions"?: ReadonlyArray<ReadonlyArray<string>>;
  readonly "x-oauth-scope"?: string;
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

function buildOperations(): ReadonlyMap<string, Operation> {
  const doc = openApiSpec as OpenApiDocument;
  const operations = new Map<string, Operation>();
  for (const [pathTemplate, methods] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (op?.operationId === undefined) continue;
      operations.set(op.operationId, {
        operationId: op.operationId,
        method: method.toUpperCase(),
        pathTemplate,
        fga: op["x-fga-permissions"] ?? [],
        oauthScope: op["x-oauth-scope"],
      });
    }
  }
  return operations;
}

/** `operationId -> Operation`, built once from the bundled spec's `paths`. */
export const OPERATIONS: ReadonlyMap<string, Operation> = buildOperations();

/**
 * Management API path versions the matcher resolves. Every path in the bundled spec starts with
 * one of these; a recorded request outside them (a project data-plane host, `/platform/` login
 * endpoints, GitHub, a registry, local Docker) is out of scope by construction, not a drift gap.
 */
const IN_SCOPE_PATH_PREFIXES = ["/v1/", "/v2/"];

/**
 * Splits a path into segments, trimming only the leading/trailing slash every path has. An
 * interior empty segment (a doubled slash, e.g. `/v1/projects//x`) is preserved rather than
 * dropped, so it can't be silently treated as "no segment here" and match a template it
 * shouldn't — see {@link templateMatchesPath}.
 */
function pathSegments(path: string): ReadonlyArray<string> {
  const withoutLeadingSlash = path.startsWith("/") ? path.slice(1) : path;
  const trimmed = withoutLeadingSlash.endsWith("/")
    ? withoutLeadingSlash.slice(0, -1)
    : withoutLeadingSlash;
  return trimmed.length === 0 ? [] : trimmed.split("/");
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function templateMatchesPath(template: string, path: string): boolean {
  const templateSegments = pathSegments(template);
  const targetSegments = pathSegments(path);
  if (templateSegments.length !== targetSegments.length) return false;
  return templateSegments.every((segment, i) => {
    const target = targetSegments[i]!;
    return isPlaceholderSegment(segment) ? target.length > 0 : segment === target;
  });
}

/** Count of non-placeholder segments, used to prefer the most specific template on a tie. */
function literalSegmentCount(template: string): number {
  return pathSegments(template).filter((segment) => !isPlaceholderSegment(segment)).length;
}

/** An absolute URL starts with a scheme; checking only the start avoids mistaking a path-only URL whose query embeds one (e.g. `/v1/projects?redirect=https://example.com`) for an absolute URL. */
const ABSOLUTE_URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function requestPathname(url: string): string {
  return ABSOLUTE_URL_SCHEME.test(url) ? new URL(url).pathname : url.split("?")[0]!;
}

function isInScopePath(pathname: string): boolean {
  return IN_SCOPE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export type OperationMatch =
  | { readonly kind: "matched"; readonly operation: Operation }
  | { readonly kind: "unmatched"; readonly method: string; readonly pathname: string }
  | { readonly kind: "out-of-scope" };

/**
 * Resolves `method` + `url` (absolute or path-only) to the operation whose path template it
 * matches, turning each `{param}` segment into a wildcard for exactly one path segment. A path
 * outside {@link IN_SCOPE_PATH_PREFIXES} resolves to `"out-of-scope"` without consulting
 * {@link OPERATIONS}; an in-scope path matching no known operation resolves to `"unmatched"`,
 * which callers should treat as a real gap (a path-template typo or a missing spec entry), not
 * something to ignore.
 */
export function matchOperation(method: string, url: string): OperationMatch {
  const pathname = requestPathname(url);
  if (!isInScopePath(pathname)) return { kind: "out-of-scope" };

  const upperMethod = method.toUpperCase();
  let best: Operation | undefined;
  for (const operation of OPERATIONS.values()) {
    if (operation.method !== upperMethod) continue;
    if (!templateMatchesPath(operation.pathTemplate, pathname)) continue;
    if (
      best === undefined ||
      literalSegmentCount(operation.pathTemplate) > literalSegmentCount(best.pathTemplate)
    ) {
      best = operation;
    }
  }
  return best === undefined
    ? { kind: "unmatched", method: upperMethod, pathname }
    : { kind: "matched", operation: best };
}
