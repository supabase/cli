import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { legacyBuildRlsAdvisory } from "./query.advisory.ts";
import {
  legacyFormatLinkedValue,
  legacyFormatValue,
  legacyMakeLocalCellFormatter,
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

  it("renders JSON objects and arrays like Go's fmt %v (not [object Object])", () => {
    // Captured from `fmt.Sprintf("%v", ...)` on the Go toolchain.
    expect(legacyFormatValue({ k: "v", z: 1, a: true })).toBe("map[a:true k:v z:1]");
    expect(legacyFormatValue([1, 2, "x"])).toBe("[1 2 x]");
    expect(legacyFormatValue({ count: 1000000 })).toBe("map[count:1e+06]");
    expect(legacyFormatValue([null])).toBe("[<nil>]");
    expect(legacyFormatValue({ arr: ["a", "b"], nested: { deep: [1, 2] } })).toBe(
      "map[arr:[a b] nested:map[deep:[1 2]]]",
    );
    expect(legacyFormatValue({})).toBe("map[]");
    expect(legacyFormatValue([])).toBe("[]");
  });

  it("renders nested JSON numbers with Go's float64 %g", () => {
    expect(legacyFormatValue([1000000, 1234567, 999999, 0.5, 100.5])).toBe(
      "[1e+06 1.234567e+06 999999 0.5 100.5]",
    );
    expect(legacyFormatValue([0.00001, 1.5e8, 12345678901234])).toBe(
      "[1e-05 1.5e+08 1.2345678901234e+13]",
    );
  });
});

describe("legacyFormatLinkedValue", () => {
  it("renders top-level JSON numbers with Go's float64 %g (interface{} path)", () => {
    // Go unmarshals linked rows into interface{}, so every number is a float64 and
    // `fmt.Sprintf("%v")` prints it with %g — unlike the local pgx path.
    expect(legacyFormatLinkedValue(1000000)).toBe("1e+06");
    expect(legacyFormatLinkedValue(1234567)).toBe("1.234567e+06");
    expect(legacyFormatLinkedValue(999999)).toBe("999999");
    expect(legacyFormatLinkedValue(0.5)).toBe("0.5");
  });

  it("matches legacyFormatValue for nil, strings, bools, and JSON containers", () => {
    expect(legacyFormatLinkedValue(null)).toBe("NULL");
    expect(legacyFormatLinkedValue(undefined)).toBe("NULL");
    expect(legacyFormatLinkedValue("hello")).toBe("hello");
    expect(legacyFormatLinkedValue(true)).toBe("true");
    expect(legacyFormatLinkedValue({ k: "v", z: 1 })).toBe("map[k:v z:1]");
  });

  it("local legacyFormatValue keeps top-level integers plain (no %g)", () => {
    // Guards the scoping: the shared formatter (local pgx path) must NOT apply %g
    // to a plain integer, or local int columns would regress to 1e+06.
    expect(legacyFormatValue(1000000)).toBe("1000000");
  });
});

describe("legacyMakeLocalCellFormatter", () => {
  // OIDs: int4=23, float4=700, float8=701, text=25.
  it("renders float4/float8 columns with %g and integer columns plain", () => {
    const fmt = legacyMakeLocalCellFormatter([23, 701, 700]);
    expect(fmt(1000000, 0)).toBe("1000000"); // int4 column → plain
    expect(fmt(1000000, 1)).toBe("1e+06"); // float8 column → %g
    expect(fmt(1000000, 2)).toBe("1e+06"); // float4 column → %g
  });

  it("leaves non-number cells (and unknown columns) to the default formatter", () => {
    const fmt = legacyMakeLocalCellFormatter([701, 25]);
    expect(fmt(null, 0)).toBe("NULL");
    expect(fmt("hi", 1)).toBe("hi");
    expect(fmt(42, 99)).toBe("42"); // no OID for the column → plain
  });
});

describe("legacyRenderTablewriter", () => {
  it("applies a custom cell formatter (linked %g) when provided", () => {
    const out = legacyRenderTablewriter(["n"], [[1000000]], legacyFormatLinkedValue);
    expect(out).toContain("1e+06");
    // Default (local) formatter keeps it plain.
    expect(legacyRenderTablewriter(["n"], [[1000000]])).toContain("1000000");
  });

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
