import { openApiOperationIdMap, operationDefinitions } from "@supabase/api/effect";

/** A request resolved to the Management API operation it calls. */
export interface MatchedOperation {
  /** The spec's operation ID, as permissions and contracts name it (`v1-delete-a-branch`). */
  readonly operationId: string;
  /** Path parameters by template name, URL-decoded. */
  readonly pathParams: Readonly<Record<string, string>>;
}

interface OperationRoute {
  readonly operationId: string;
  readonly method: string;
  readonly segments: ReadonlyArray<string>;
  readonly literalCount: number;
}

const segmentsOf = (path: string): ReadonlyArray<string> => {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? [] : trimmed.split("/");
};

const isPlaceholder = (segment: string) => segment.startsWith("{") && segment.endsWith("}");

const buildRoutes = (): ReadonlyArray<OperationRoute> => {
  const operationIdByDefinition = new Map(
    Object.entries(openApiOperationIdMap).map(([operationId, definitionId]) => [
      definitionId,
      operationId,
    ]),
  );
  return Object.values(operationDefinitions).flatMap((definition) => {
    const operationId = operationIdByDefinition.get(definition.id);
    if (operationId === undefined) return [];
    const segments = segmentsOf(definition.path);
    return [
      {
        operationId,
        method: definition.method,
        segments,
        literalCount: segments.filter((segment) => !isPlaceholder(segment)).length,
      },
    ];
  });
};

let routes: ReadonlyArray<OperationRoute> | undefined;

/**
 * Resolves `method` and the request URL's path to a Management API operation. A placeholder matches
 * exactly one non-empty segment, and the template with the most literal segments wins a tie.
 */
export function matchManagementApiOperation(
  method: string,
  url: string,
): MatchedOperation | undefined {
  routes ??= buildRoutes();
  const target = segmentsOf(new URL(url, "http://invalid").pathname);
  const upperMethod = method.toUpperCase();
  let best: OperationRoute | undefined;
  for (const route of routes) {
    if (route.method !== upperMethod || route.segments.length !== target.length) continue;
    const matches = route.segments.every((segment, i) => {
      const actual = target[i] ?? "";
      return isPlaceholder(segment) ? actual.length > 0 : segment === actual;
    });
    if (matches && (best === undefined || route.literalCount > best.literalCount)) best = route;
  }
  if (best === undefined) return undefined;
  const pathParams: Record<string, string> = {};
  best.segments.forEach((segment, i) => {
    if (isPlaceholder(segment)) {
      pathParams[segment.slice(1, -1)] = decodeURIComponent(target[i] ?? "");
    }
  });
  return { operationId: best.operationId, pathParams };
}
