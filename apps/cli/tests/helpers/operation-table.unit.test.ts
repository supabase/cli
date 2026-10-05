import { describe, expect, it } from "vitest";

import { matchOperation, OPERATIONS } from "./operation-table.ts";

/** Builds a concrete path from a template, substituting each `{param}` with `sampleValue`. */
function samplePath(template: string, sampleValue = "sample-value"): string {
  return template.replaceAll(/\{[^}]+\}/g, sampleValue);
}

describe("operation-table", () => {
  it("resolves a sample URL built from every operation's own template back to that operation", () => {
    for (const operation of OPERATIONS.values()) {
      const url = `https://api.supabase.com${samplePath(operation.pathTemplate)}`;
      const match = matchOperation(operation.method, url);
      expect(
        match,
        `${operation.method} ${operation.pathTemplate} (${operation.operationId})`,
      ).toEqual({
        kind: "matched",
        operation,
      });
    }
  });

  it("ignores a path outside the Management API's /v1/ and /v2/ prefixes", () => {
    expect(matchOperation("GET", "https://api.supabase.com/platform/cli/login/session-id")).toEqual(
      {
        kind: "out-of-scope",
      },
    );
    expect(
      matchOperation("GET", "https://project-ref.supabase.co/storage/v1/object/list/bucket"),
    ).toEqual({
      kind: "out-of-scope",
    });
  });

  it("reports an in-scope path matching no known operation as unmatched", () => {
    const match = matchOperation("GET", "https://api.supabase.com/v1/not-a-real-route");
    expect(match).toEqual({
      kind: "unmatched",
      method: "GET",
      pathname: "/v1/not-a-real-route",
    });
  });

  it("prefers the template with more literal segments over one with a placeholder in the same position", () => {
    // Real ambiguity in the spec: "/v1/projects/available-regions" (literal) also satisfies
    // "/v1/projects/{ref}" (placeholder) if {ref} is read as the literal string
    // "available-regions". The literal template must win.
    const match = matchOperation("GET", "https://api.supabase.com/v1/projects/available-regions");
    expect(match.kind).toBe("matched");
    expect(match.kind === "matched" && match.operation.operationId).toBe(
      "v1-get-available-regions",
    );

    // A real {ref} value still resolves to the placeholder template.
    const refMatch = matchOperation(
      "GET",
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst",
    );
    expect(refMatch.kind).toBe("matched");
    expect(refMatch.kind === "matched" && refMatch.operation.operationId).toBe("v1-get-project");
  });

  it("has no same-method, equal-literal-count path template collision the tie-break can't resolve", () => {
    function segments(template: string): ReadonlyArray<string> {
      return template.split("/").filter((segment) => segment.length > 0);
    }
    function isPlaceholder(segment: string): boolean {
      return segment.startsWith("{") && segment.endsWith("}");
    }
    function literalCount(template: string): number {
      return segments(template).filter((segment) => !isPlaceholder(segment)).length;
    }
    function overlaps(a: string, b: string): boolean {
      const segsA = segments(a);
      const segsB = segments(b);
      if (segsA.length !== segsB.length) return false;
      return segsA.every(
        (segment, i) => segment === segsB[i] || isPlaceholder(segment) || isPlaceholder(segsB[i]!),
      );
    }

    const operations = [...OPERATIONS.values()];
    const unresolvedTies: Array<string> = [];
    for (let i = 0; i < operations.length; i++) {
      for (let j = i + 1; j < operations.length; j++) {
        const a = operations[i]!;
        const b = operations[j]!;
        if (a.method !== b.method) continue;
        if (a.pathTemplate === b.pathTemplate) continue;
        if (!overlaps(a.pathTemplate, b.pathTemplate)) continue;
        if (literalCount(a.pathTemplate) === literalCount(b.pathTemplate)) {
          unresolvedTies.push(
            `${a.method} ${a.pathTemplate} (${a.operationId}) <-> ${b.pathTemplate} (${b.operationId})`,
          );
        }
      }
    }
    expect(unresolvedTies, unresolvedTies.join("\n")).toEqual([]);
  });
});
