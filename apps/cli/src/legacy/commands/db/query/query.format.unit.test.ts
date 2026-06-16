import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { legacyBuildRlsAdvisory } from "./query.advisory.ts";
import {
  legacyFormatValue,
  legacyOrderedKeys,
  legacyRenderJson,
  legacyRenderTablewriter,
  legacyResolveAgentMode,
  legacyToCsv,
} from "./query.format.ts";

describe("legacyFormatValue", () => {
  it("renders nil as NULL and scalars via their string form", () => {
    expect(legacyFormatValue(null)).toBe("NULL");
    expect(legacyFormatValue(undefined)).toBe("NULL");
    expect(legacyFormatValue(42)).toBe("42");
    expect(legacyFormatValue("hello")).toBe("hello");
    expect(legacyFormatValue(true)).toBe("true");
  });
});

describe("legacyRenderTablewriter", () => {
  it("matches the olekukonko/tablewriter v1 box layout (AutoFormat off, NULL cells)", () => {
    const out = legacyRenderTablewriter(
      ["num", "greeting"],
      [
        [1, "hello"],
        [null, "world"],
      ],
    );
    expect(out).toBe(
      [
        "┌──────┬──────────┐",
        "│ num  │ greeting │",
        "├──────┼──────────┤",
        "│ 1    │ hello    │",
        "│ NULL │ world    │",
        "└──────┴──────────┘",
        "",
      ].join("\n"),
    );
  });

  it("renders nothing for an empty column set", () => {
    expect(legacyRenderTablewriter([], [])).toBe("");
  });
});

describe("legacyToCsv", () => {
  it("writes an RFC4180 header + rows with NULL cells and \\n terminators", () => {
    expect(legacyToCsv(["a", "b"], [[1, 2]])).toBe("a,b\n1,2\n");
    expect(legacyToCsv(["a", "b"], [[null, "x"]])).toBe("a,b\nNULL,x\n");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    expect(legacyToCsv(["c"], [["a,b"]])).toBe('c\n"a,b"\n');
    expect(legacyToCsv(["c"], [['he said "hi"']])).toBe('c\n"he said ""hi"""\n');
  });
});

describe("legacyRenderJson", () => {
  it("emits a plain rows array (sorted keys, trailing newline) for humans", () => {
    const out = legacyRenderJson(["b", "a"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "a": 2,\n    "b": 1\n  }\n]\n');
  });

  it("wraps agent results in the untrusted-data envelope with HTML-escaped boundary markers", () => {
    const out = legacyRenderJson(["id"], [[1]], true, "deadbeef", Option.none());
    // Envelope keys in Go map-sort order: boundary, rows, warning (no advisory).
    const boundaryIdx = out.indexOf('"boundary"');
    const rowsIdx = out.indexOf('"rows"');
    const warningIdx = out.indexOf('"warning"');
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(boundaryIdx).toBeLessThan(rowsIdx);
    expect(rowsIdx).toBeLessThan(warningIdx);
    // Go's json.Encoder HTML-escapes < and > (it never calls SetEscapeHTML(false)).
    expect(out).toContain("\\u003cdeadbeef\\u003e");
    expect(out).not.toContain("<deadbeef>");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.boundary).toBe("deadbeef");
    expect(parsed.rows).toEqual([{ id: 1 }]);
    expect(parsed.advisory).toBeUndefined();
  });

  it("includes the advisory (struct field order) before the other envelope keys", () => {
    const advisory = legacyBuildRlsAdvisory(["public.users"]);
    const out = legacyRenderJson(["id"], [[1]], true, "ab", advisory);
    expect(out.indexOf('"advisory"')).toBeLessThan(out.indexOf('"boundary"'));
    const parsed = JSON.parse(out);
    expect(parsed.advisory.id).toBe("rls_disabled");
    expect(parsed.advisory.remediation_sql).toBe(
      "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;",
    );
    // Advisory keys keep Go struct declaration order, not sorted.
    const advisoryJson = out.slice(out.indexOf('"advisory"'));
    expect(advisoryJson.indexOf('"id"')).toBeLessThan(advisoryJson.indexOf('"priority"'));
    expect(advisoryJson.indexOf('"priority"')).toBeLessThan(advisoryJson.indexOf('"level"'));
  });
});

describe("legacyOrderedKeys", () => {
  it("returns the first object's keys in source order", () => {
    expect(legacyOrderedKeys('[{"name":"a","id":1}]')).toEqual(["name", "id"]);
  });

  it("returns [] for a non-array or empty body", () => {
    expect(legacyOrderedKeys("not json")).toEqual([]);
    expect(legacyOrderedKeys("[]")).toEqual([]);
    expect(legacyOrderedKeys('{"a":1}')).toEqual([]);
  });
});

describe("legacyResolveAgentMode", () => {
  it("honors the explicit flag and falls back to detection on auto", () => {
    expect(legacyResolveAgentMode("yes", Option.none())).toBe(true);
    expect(legacyResolveAgentMode("no", Option.some("cursor"))).toBe(false);
    expect(legacyResolveAgentMode("auto", Option.some("cursor"))).toBe(true);
    expect(legacyResolveAgentMode("auto", Option.none())).toBe(false);
  });
});

describe("legacyBuildRlsAdvisory", () => {
  it("returns None when no tables are unprotected", () => {
    expect(Option.isNone(legacyBuildRlsAdvisory([]))).toBe(true);
  });

  it("lists the unprotected tables and joins remediation statements", () => {
    const advisory = legacyBuildRlsAdvisory(["public.a", "public.b"]);
    expect(Option.isSome(advisory)).toBe(true);
    if (Option.isSome(advisory)) {
      expect(advisory.value.message).toContain("2 table(s)");
      expect(advisory.value.message).toContain("public.a, public.b");
      expect(advisory.value.remediation_sql).toBe(
        "ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;\nALTER TABLE public.b ENABLE ROW LEVEL SECURITY;",
      );
    }
  });
});
