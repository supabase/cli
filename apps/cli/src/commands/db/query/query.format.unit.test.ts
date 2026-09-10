import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { buildRlsAdvisory } from "./query.advisory.ts";
import {
  coerceLocalJsonRows,
  findNonFiniteJsonValue,
  formatLinkedValue,
  formatValue,
  makeLocalCellFormatter,
  orderedKeys,
  renderJson,
  renderTablewriter,
  resolveAgentMode,
  toCsv,
} from "./query.format.ts";

describe("formatValue", () => {
  it("renders nil as NULL and scalars via their string form", () => {
    expect(formatValue(null)).toBe("NULL");
    expect(formatValue(undefined)).toBe("NULL");
    expect(formatValue(42)).toBe("42");
    expect(formatValue("hello")).toBe("hello");
    expect(formatValue(true)).toBe("true");
  });

  it("renders JSON objects and arrays like Go's fmt %v (not [object Object])", () => {
    expect(formatValue({ k: "v", z: 1, a: true })).toBe("map[a:true k:v z:1]");
    expect(formatValue([1, 2, "x"])).toBe("[1 2 x]");
    expect(formatValue({ count: 1000000 })).toBe("map[count:1e+06]");
    expect(formatValue([null])).toBe("[<nil>]");
    expect(formatValue({ arr: ["a", "b"], nested: { deep: [1, 2] } })).toBe(
      "map[arr:[a b] nested:map[deep:[1 2]]]",
    );
    expect(formatValue({})).toBe("map[]");
    expect(formatValue([])).toBe("[]");
  });

  it("renders nested JSON numbers with Go's float64 %g", () => {
    expect(formatValue([1000000, 1234567, 999999, 0.5, 100.5])).toBe(
      "[1e+06 1.234567e+06 999999 0.5 100.5]",
    );
    expect(formatValue([0.00001, 1.5e8, 12345678901234])).toBe(
      "[1e-05 1.5e+08 1.2345678901234e+13]",
    );
  });

  it("renders bytea (Buffer/Uint8Array) as Go's []byte %v decimal array, not map[]", () => {
    expect(formatValue(new Uint8Array([222, 173, 190, 239]))).toBe("[222 173 190 239]");
    expect(formatValue(new Uint8Array([]))).toBe("[]");
  });
});

describe("formatLinkedValue", () => {
  it("renders top-level JSON numbers with Go's float64 %g (interface{} path)", () => {
    expect(formatLinkedValue(1000000)).toBe("1e+06");
    expect(formatLinkedValue(1234567)).toBe("1.234567e+06");
    expect(formatLinkedValue(999999)).toBe("999999");
    expect(formatLinkedValue(0.5)).toBe("0.5");
  });

  it("matches formatValue for nil, strings, bools, and JSON containers", () => {
    expect(formatLinkedValue(null)).toBe("NULL");
    expect(formatLinkedValue(undefined)).toBe("NULL");
    expect(formatLinkedValue("hello")).toBe("hello");
    expect(formatLinkedValue(true)).toBe("true");
    expect(formatLinkedValue({ k: "v", z: 1 })).toBe("map[k:v z:1]");
  });

  it("local formatValue keeps top-level integers plain (no %g)", () => {
    expect(formatValue(1000000)).toBe("1000000");
  });
});

describe("makeLocalCellFormatter", () => {
  // OIDs: int4=23, float4=700, float8=701, text=25.
  it("renders float4/float8 columns with %g and integer columns plain", () => {
    const fmt = makeLocalCellFormatter([23, 701, 700]);
    expect(fmt(1000000, 0)).toBe("1000000");
    expect(fmt(1000000, 1)).toBe("1e+06");
    expect(fmt(1000000, 2)).toBe("1e+06");
  });

  it("leaves non-number cells (and unknown columns) to the default formatter", () => {
    const fmt = makeLocalCellFormatter([701, 25]);
    expect(fmt(null, 0)).toBe("NULL");
    expect(fmt("hi", 1)).toBe("hi");
    expect(fmt(42, 99)).toBe("42");
  });

  it("preserves negative zero in a float column like Go's %v (-0, not 0)", () => {
    const fmt = makeLocalCellFormatter([701, 701]);
    expect(fmt(-0, 0)).toBe("-0");
    expect(fmt(0, 1)).toBe("0");
  });

  it("renders Date (timestamp) cells like Go's time.Time %v instead of map[]", () => {
    const fmt = makeLocalCellFormatter([1114]);
    expect(fmt(new Date(Date.UTC(2024, 0, 2, 15, 4, 5)), 0)).toBe("2024-01-02 15:04:05 +0000 UTC");
    expect(fmt(new Date(Date.UTC(2024, 0, 2, 15, 4, 5, 123)), 0)).toBe(
      "2024-01-02 15:04:05.123 +0000 UTC",
    );
  });

  it("preserves microseconds for raw timestamp text (OID 1114), trimming zeros", () => {
    // Raw text preserves microseconds; a JS Date is millisecond-only.
    const fmt = makeLocalCellFormatter([1114]);
    expect(fmt("2026-01-01 00:00:00.123456", 0)).toBe("2026-01-01 00:00:00.123456 +0000 UTC");
    expect(fmt("2026-01-01 00:00:00.12", 0)).toBe("2026-01-01 00:00:00.12 +0000 UTC");
    expect(fmt("2026-01-01 00:00:00", 0)).toBe("2026-01-01 00:00:00 +0000 UTC");
  });

  it("shifts a timestamptz (OID 1184) to UTC while keeping microseconds", () => {
    const fmt = makeLocalCellFormatter([1184]);
    expect(fmt("2026-01-01 00:00:00.123456+00", 0)).toBe("2026-01-01 00:00:00.123456 +0000 UTC");
    expect(fmt("2026-01-01 05:30:00.5-07", 0)).toBe("2026-01-01 12:30:00.5 +0000 UTC");
  });

  it("renders a date (OID 1082) as Go's midnight-UTC time.Time", () => {
    const fmt = makeLocalCellFormatter([1082]);
    expect(fmt("2026-01-01", 0)).toBe("2026-01-01 00:00:00 +0000 UTC");
  });

  it("preserves years below 100 (Date.UTC would remap 0001 → 1901)", () => {
    const fmt = makeLocalCellFormatter([1082]);
    expect(fmt("0001-01-01", 0)).toBe("0001-01-01 00:00:00 +0000 UTC");
    expect(fmt("0099-12-31", 0)).toBe("0099-12-31 00:00:00 +0000 UTC");
  });

  it("falls back to the raw text for an unrecognized timestamp value", () => {
    const fmt = makeLocalCellFormatter([1114]);
    expect(fmt("infinity", 0)).toBe("infinity");
  });
});

describe("coerceLocalJsonRows", () => {
  // OIDs: int8=20, text=25.
  it("coerces in-range int8 string cells to JSON numbers, leaves others alone", () => {
    const out = coerceLocalJsonRows([["42", "hi"]], [20, 25]);
    expect(out[0]?.[0]).toBe(42);
    expect(out[0]?.[1]).toBe("hi");
  });

  it("emits out-of-safe-range int8 as an exact bare JSON number (not a string)", () => {
    const huge = "9223372036854775807"; // > Number.MAX_SAFE_INTEGER
    const coerced = coerceLocalJsonRows([[huge]], [20]);
    const out = renderJson(["n"], coerced, false, "", Option.none());
    expect(out).toContain(`"n": ${huge}`);
    expect(out).not.toContain(`"${huge}"`);
  });

  it("coerces bytea (Buffer/Uint8Array) cells to standard base64 like Go's json.Marshal", () => {
    // OID 17 = bytea.
    const out = coerceLocalJsonRows([[new Uint8Array([222, 173, 190, 239])]], [17]);
    expect(out[0]?.[0]).toBe("3q2+7w==");
  });

  it("coerces timestamp/timestamptz/date cells to Go's RFC3339Nano (UTC, microseconds)", () => {
    expect(coerceLocalJsonRows([["2026-01-01 00:00:00.123456"]], [1114])[0]?.[0]).toBe(
      "2026-01-01T00:00:00.123456Z",
    );
    expect(coerceLocalJsonRows([["2026-01-01 05:30:00.5-07"]], [1184])[0]?.[0]).toBe(
      "2026-01-01T12:30:00.5Z",
    );
    expect(coerceLocalJsonRows([["2026-01-01"]], [1082])[0]?.[0]).toBe("2026-01-01T00:00:00Z");
  });
});

describe("renderTablewriter", () => {
  it("applies a custom cell formatter (linked %g) when provided", () => {
    const out = renderTablewriter(["n"], [[1000000]], formatLinkedValue);
    expect(out).toContain("1e+06");
    expect(renderTablewriter(["n"], [[1000000]])).toContain("1000000");
  });

  it("splits a multiline cell across stacked rows like tablewriter (borders intact)", () => {
    const out = renderTablewriter(
      ["id", "body"],
      [
        [1, "line one\nline two"],
        [2, "single"],
      ],
    );
    expect(out).toBe(
      [
        "┌────┬──────────┐",
        "│ id │ body     │",
        "├────┼──────────┤",
        "│ 1  │ line one │",
        "│    │ line two │",
        "│ 2  │ single   │",
        "└────┴──────────┘",
        "",
      ].join("\n"),
    );
  });

  it("matches the olekukonko/tablewriter v1 box layout (AutoFormat off, NULL cells)", () => {
    const out = renderTablewriter(
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

  it("sizes columns by terminal rune width so CJK cells stay aligned (Go runewidth)", () => {
    // "日本語" is 6 display columns, not 3 code points.
    const out = renderTablewriter(["name"], [["日本語"], ["ab"]]);
    expect(out).toBe(
      ["┌────────┐", "│ name   │", "├────────┤", "│ 日本語 │", "│ ab     │", "└────────┘", ""].join(
        "\n",
      ),
    );
  });

  it("renders nothing for an empty column set", () => {
    expect(renderTablewriter([], [])).toBe("");
  });
});

describe("toCsv", () => {
  it("writes an RFC4180 header + rows with NULL cells and \\n terminators", () => {
    expect(toCsv(["a", "b"], [[1, 2]])).toBe("a,b\n1,2\n");
    expect(toCsv(["a", "b"], [[null, "x"]])).toBe("a,b\nNULL,x\n");
  });

  it("quotes fields containing commas, quotes, or newlines", () => {
    expect(toCsv(["c"], [["a,b"]])).toBe('c\n"a,b"\n');
    expect(toCsv(["c"], [['he said "hi"']])).toBe('c\n"he said ""hi"""\n');
  });
});

describe("renderJson", () => {
  it("emits a plain rows array (sorted keys, trailing newline) for humans", () => {
    const out = renderJson(["b", "a"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "a": 2,\n    "b": 1\n  }\n]\n');
  });

  it("keeps integer-like column keys in Go's lexicographic order (not JS numeric)", () => {
    const out = renderJson(["10", "2"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "10": 1,\n    "2": 2\n  }\n]\n');
  });

  it("collapses duplicate column names to the last value (Go's map overwrite)", () => {
    const out = renderJson(["x", "x"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "x": 2\n  }\n]\n');
  });

  it("preserves negative zero like Go's json.Encoder (-0, not 0)", () => {
    const out = renderJson(["n"], [[-0]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "n": -0\n  }\n]\n');
  });

  it("wraps agent results in the untrusted-data envelope with HTML-escaped boundary markers", () => {
    const out = renderJson(["id"], [[1]], true, "deadbeef", Option.none());
    const boundaryIdx = out.indexOf('"boundary"');
    const rowsIdx = out.indexOf('"rows"');
    const warningIdx = out.indexOf('"warning"');
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(boundaryIdx).toBeLessThan(rowsIdx);
    expect(rowsIdx).toBeLessThan(warningIdx);
    expect(out).toContain("\\u003cdeadbeef\\u003e");
    expect(out).not.toContain("<deadbeef>");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.boundary).toBe("deadbeef");
    expect(parsed.rows).toEqual([{ id: 1 }]);
    expect(parsed.advisory).toBeUndefined();
  });

  it("includes the advisory (struct field order) before the other envelope keys", () => {
    const advisory = buildRlsAdvisory(["public.users"]);
    const out = renderJson(["id"], [[1]], true, "ab", advisory);
    expect(out.indexOf('"advisory"')).toBeLessThan(out.indexOf('"boundary"'));
    const parsed = JSON.parse(out);
    expect(parsed.advisory.id).toBe("rls_disabled");
    expect(parsed.advisory.remediation_sql).toBe(
      "ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;",
    );
    const advisoryJson = out.slice(out.indexOf('"advisory"'));
    expect(advisoryJson.indexOf('"id"')).toBeLessThan(advisoryJson.indexOf('"priority"'));
    expect(advisoryJson.indexOf('"priority"')).toBeLessThan(advisoryJson.indexOf('"level"'));
  });
});

describe("orderedKeys", () => {
  it("returns the first object's keys in source order", () => {
    expect(orderedKeys('[{"name":"a","id":1}]')).toEqual(["name", "id"]);
  });

  it("preserves integer-like alias order (Object.keys would reorder them numerically)", () => {
    expect(orderedKeys('[{"10":1,"2":2,"name":3}]')).toEqual(["10", "2", "name"]);
  });

  it("ignores keys nested inside object/array values", () => {
    expect(orderedKeys('[{"a":{"z":1},"b":[{"y":2}],"c":3}]')).toEqual(["a", "b", "c"]);
  });

  it("handles escaped quotes in keys and string values", () => {
    expect(orderedKeys('[{"a\\"b":"x:y","c":1}]')).toEqual(['a"b', "c"]);
  });

  it("returns [] for a non-array or empty body", () => {
    expect(orderedKeys("not json")).toEqual([]);
    expect(orderedKeys("[]")).toEqual([]);
    expect(orderedKeys('{"a":1}')).toEqual([]);
  });
});

describe("findNonFiniteJsonValue", () => {
  it("returns Go's token for the first non-finite float, else undefined", () => {
    expect(findNonFiniteJsonValue([[1, "x", 2.5]])).toBeUndefined();
    expect(findNonFiniteJsonValue([[Number.NaN]])).toBe("NaN");
    expect(findNonFiniteJsonValue([[Number.POSITIVE_INFINITY]])).toBe("+Inf");
    expect(findNonFiniteJsonValue([[1], [Number.NEGATIVE_INFINITY]])).toBe("-Inf");
  });
});

describe("resolveAgentMode", () => {
  it("honors the explicit flag and falls back to detection on auto", () => {
    expect(resolveAgentMode("yes", Option.none())).toBe(true);
    expect(resolveAgentMode("no", Option.some("cursor"))).toBe(false);
    expect(resolveAgentMode("auto", Option.some("cursor"))).toBe(true);
    expect(resolveAgentMode("auto", Option.none())).toBe(false);
  });
});

describe("buildRlsAdvisory", () => {
  it("returns None when no tables are unprotected", () => {
    expect(Option.isNone(buildRlsAdvisory([]))).toBe(true);
  });

  it("lists the unprotected tables and joins remediation statements", () => {
    const advisory = buildRlsAdvisory(["public.a", "public.b"]);
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
