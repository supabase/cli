import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { legacyBuildRlsAdvisory } from "./query.advisory.ts";
import {
  legacyCoerceLocalJsonRows,
  legacyFindNonFiniteJsonValue,
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

  it("renders bytea (Buffer/Uint8Array) as Go's []byte %v decimal array, not map[]", () => {
    // Go scans bytea into []byte; `fmt.Sprintf("%v", []byte{222,173,190,239})` → "[222 173 190 239]".
    expect(legacyFormatValue(new Uint8Array([222, 173, 190, 239]))).toBe("[222 173 190 239]");
    expect(legacyFormatValue(new Uint8Array([]))).toBe("[]");
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

  it("preserves negative zero in a float column like Go's %v (-0, not 0)", () => {
    const fmt = legacyMakeLocalCellFormatter([701, 701]);
    expect(fmt(-0, 0)).toBe("-0"); // float8 column → Go keeps the sign
    expect(fmt(0, 1)).toBe("0"); // positive zero stays plain
  });

  it("renders Date (timestamp) cells like Go's time.Time %v instead of map[]", () => {
    const fmt = legacyMakeLocalCellFormatter([1114]);
    expect(fmt(new Date(Date.UTC(2024, 0, 2, 15, 4, 5)), 0)).toBe("2024-01-02 15:04:05 +0000 UTC");
    expect(fmt(new Date(Date.UTC(2024, 0, 2, 15, 4, 5, 123)), 0)).toBe(
      "2024-01-02 15:04:05.123 +0000 UTC",
    );
  });

  it("preserves microseconds for raw timestamp text (OID 1114), trimming zeros", () => {
    // node-postgres' Date is millisecond-only; the raw-text override keeps the µs that
    // Go's pgx time.Time prints via `%v`.
    const fmt = legacyMakeLocalCellFormatter([1114]);
    expect(fmt("2026-01-01 00:00:00.123456", 0)).toBe("2026-01-01 00:00:00.123456 +0000 UTC");
    expect(fmt("2026-01-01 00:00:00.12", 0)).toBe("2026-01-01 00:00:00.12 +0000 UTC");
    expect(fmt("2026-01-01 00:00:00", 0)).toBe("2026-01-01 00:00:00 +0000 UTC");
  });

  it("shifts a timestamptz (OID 1184) to UTC while keeping microseconds", () => {
    const fmt = legacyMakeLocalCellFormatter([1184]);
    expect(fmt("2026-01-01 00:00:00.123456+00", 0)).toBe("2026-01-01 00:00:00.123456 +0000 UTC");
    // -07:00 zone → add 7h to reach UTC; the sub-second fraction is untouched.
    expect(fmt("2026-01-01 05:30:00.5-07", 0)).toBe("2026-01-01 12:30:00.5 +0000 UTC");
  });

  it("renders a date (OID 1082) as Go's midnight-UTC time.Time", () => {
    const fmt = legacyMakeLocalCellFormatter([1082]);
    expect(fmt("2026-01-01", 0)).toBe("2026-01-01 00:00:00 +0000 UTC");
  });

  it("preserves years below 100 (Date.UTC would remap 0001 → 1901)", () => {
    const fmt = legacyMakeLocalCellFormatter([1082]);
    expect(fmt("0001-01-01", 0)).toBe("0001-01-01 00:00:00 +0000 UTC");
    expect(fmt("0099-12-31", 0)).toBe("0099-12-31 00:00:00 +0000 UTC");
  });

  it("falls back to the raw text for an unrecognized timestamp value", () => {
    const fmt = legacyMakeLocalCellFormatter([1114]);
    expect(fmt("infinity", 0)).toBe("infinity");
  });
});

describe("legacyCoerceLocalJsonRows", () => {
  // OIDs: int8=20, text=25.
  it("coerces in-range int8 string cells to JSON numbers, leaves others alone", () => {
    const out = legacyCoerceLocalJsonRows([["42", "hi"]], [20, 25]);
    expect(out[0]?.[0]).toBe(42); // int8 within safe range → number
    expect(out[0]?.[1]).toBe("hi"); // text → unchanged
  });

  it("emits out-of-safe-range int8 as an exact bare JSON number (not a string)", () => {
    // Go scans int8 as int64 and json.Marshal emits the full integer; JS numbers lose
    // precision past 2^53, so we coerce to a raw JSON number token instead.
    const huge = "9223372036854775807"; // > Number.MAX_SAFE_INTEGER
    const coerced = legacyCoerceLocalJsonRows([[huge]], [20]);
    const out = legacyRenderJson(["n"], coerced, false, "", Option.none());
    expect(out).toContain(`"n": ${huge}`); // bare number token, unquoted, exact
    expect(out).not.toContain(`"${huge}"`); // not a quoted string
  });

  it("coerces bytea (Buffer/Uint8Array) cells to standard base64 like Go's json.Marshal", () => {
    // OID 17 = bytea. Go encodes []byte as a base64 string in JSON output.
    const out = legacyCoerceLocalJsonRows([[new Uint8Array([222, 173, 190, 239])]], [17]);
    expect(out[0]?.[0]).toBe("3q2+7w==");
  });

  it("coerces timestamp/timestamptz/date cells to Go's RFC3339Nano (UTC, microseconds)", () => {
    // Go marshals a time.Time as RFC3339Nano; node-postgres' Date would lose the µs.
    expect(legacyCoerceLocalJsonRows([["2026-01-01 00:00:00.123456"]], [1114])[0]?.[0]).toBe(
      "2026-01-01T00:00:00.123456Z",
    );
    expect(legacyCoerceLocalJsonRows([["2026-01-01 05:30:00.5-07"]], [1184])[0]?.[0]).toBe(
      "2026-01-01T12:30:00.5Z",
    );
    expect(legacyCoerceLocalJsonRows([["2026-01-01"]], [1082])[0]?.[0]).toBe(
      "2026-01-01T00:00:00Z",
    );
  });
});

describe("legacyRenderTablewriter", () => {
  it("applies a custom cell formatter (linked %g) when provided", () => {
    const out = legacyRenderTablewriter(["n"], [[1000000]], legacyFormatLinkedValue);
    expect(out).toContain("1e+06");
    // Default (local) formatter keeps it plain.
    expect(legacyRenderTablewriter(["n"], [[1000000]])).toContain("1000000");
  });

  it("splits a multiline cell across stacked rows like tablewriter (borders intact)", () => {
    const out = legacyRenderTablewriter(
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

  it("sizes columns by terminal rune width so CJK cells stay aligned (Go runewidth)", () => {
    // "日本語" is 6 display columns, not 3 code points; the borders must match its width.
    const out = legacyRenderTablewriter(["name"], [["日本語"], ["ab"]]);
    expect(out).toBe(
      ["┌────────┐", "│ name   │", "├────────┤", "│ 日本語 │", "│ ab     │", "└────────┘", ""].join(
        "\n",
      ),
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

  it("keeps integer-like column keys in Go's lexicographic order (not JS numeric)", () => {
    // `select 1 as "10", 2 as "2"` — Go's map marshal emits "10" before "2"; a plain
    // JS object would reorder them numerically to "2","10".
    const out = legacyRenderJson(["10", "2"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "10": 1,\n    "2": 2\n  }\n]\n');
  });

  it("collapses duplicate column names to the last value (Go's map overwrite)", () => {
    // `select 1 as x, 2 as x` — Go's writeJSON map keeps a single "x" with the last value.
    const out = legacyRenderJson(["x", "x"], [[1, 2]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "x": 2\n  }\n]\n');
  });

  it("preserves negative zero like Go's json.Encoder (-0, not 0)", () => {
    // `select '-0'::float8 as n` — Go emits `-0`; JSON.stringify(-0) would collapse to `0`.
    const out = legacyRenderJson(["n"], [[-0]], false, "", Option.none());
    expect(out).toBe('[\n  {\n    "n": -0\n  }\n]\n');
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

  it("preserves integer-like alias order (Object.keys would reorder them numerically)", () => {
    // `select 1 as "10", 2 as "2"` → Go keeps source order; JS Object.keys → ["2","10"].
    expect(legacyOrderedKeys('[{"10":1,"2":2,"name":3}]')).toEqual(["10", "2", "name"]);
  });

  it("ignores keys nested inside object/array values", () => {
    expect(legacyOrderedKeys('[{"a":{"z":1},"b":[{"y":2}],"c":3}]')).toEqual(["a", "b", "c"]);
  });

  it("handles escaped quotes in keys and string values", () => {
    expect(legacyOrderedKeys('[{"a\\"b":"x:y","c":1}]')).toEqual(['a"b', "c"]);
  });

  it("returns [] for a non-array or empty body", () => {
    expect(legacyOrderedKeys("not json")).toEqual([]);
    expect(legacyOrderedKeys("[]")).toEqual([]);
    expect(legacyOrderedKeys('{"a":1}')).toEqual([]);
  });
});

describe("legacyFindNonFiniteJsonValue", () => {
  it("returns Go's token for the first non-finite float, else undefined", () => {
    expect(legacyFindNonFiniteJsonValue([[1, "x", 2.5]])).toBeUndefined();
    expect(legacyFindNonFiniteJsonValue([[Number.NaN]])).toBe("NaN");
    expect(legacyFindNonFiniteJsonValue([[Number.POSITIVE_INFINITY]])).toBe("+Inf");
    expect(legacyFindNonFiniteJsonValue([[1], [Number.NEGATIVE_INFINITY]])).toBe("-Inf");
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
