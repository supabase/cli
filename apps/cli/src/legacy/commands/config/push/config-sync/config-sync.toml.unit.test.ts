import { describe, expect, it } from "vitest";

import { encodeToml, type TomlField } from "./config-sync.toml.ts";

/**
 * Unit coverage for the BurntSushi-parity rules the per-service goldens rely on:
 * field ordering (primitives before tables), `omitempty` / nil-pointer drops,
 * int formatting (no `.0`), the depth-1-only blank line before table headers,
 * string escaping, and sorted map / set keys.
 */
describe("encodeToml", () => {
  it("emits primitives in declaration order with Go scalar formatting", () => {
    const fields: ReadonlyArray<TomlField> = [
      { key: "enabled", node: { kind: "bool" } },
      { key: "name", node: { kind: "string" } },
      { key: "count", node: { kind: "int" } },
      { key: "tags", node: { kind: "array", elem: { kind: "string" } } },
      { key: "empty", node: { kind: "array", elem: { kind: "string" } } },
    ];
    expect(
      encodeToml(fields, { enabled: true, name: "pg", count: 100, tags: ["a", "b"], empty: [] }),
    ).toBe('enabled = true\nname = "pg"\ncount = 100\ntags = ["a", "b"]\nempty = []\n');
  });

  it("omits nil pointers (undefined) and omitempty zero values", () => {
    const fields: ReadonlyArray<TomlField> = [
      { key: "kept", node: { kind: "bool" } },
      { key: "nilptr", node: { kind: "string" } },
      { key: "auto", node: { kind: "bool" }, omitempty: true },
    ];
    // nilptr undefined → dropped; auto false + omitempty → dropped.
    expect(encodeToml(fields, { kept: false, nilptr: undefined, auto: false })).toBe(
      "kept = false\n",
    );
    // A non-nil pointer to false (omitempty) is kept when truthy is irrelevant —
    // here auto is true so it survives omitempty.
    expect(encodeToml(fields, { kept: true, nilptr: "x", auto: true })).toBe(
      'kept = true\nnilptr = "x"\nauto = true\n',
    );
  });

  it("prefixes a blank line before depth-1 tables only", () => {
    const fields: ReadonlyArray<TomlField> = [
      { key: "enabled", node: { kind: "bool" } },
      {
        key: "tls",
        node: {
          kind: "struct",
          fields: [
            { key: "enabled", node: { kind: "bool" } },
            {
              key: "inner",
              node: { kind: "struct", fields: [{ key: "deep", node: { kind: "bool" } }] },
            },
          ],
        },
      },
    ];
    // [tls] is depth-1 → blank line before it; [tls.inner] depth-2 → no blank.
    expect(
      encodeToml(fields, { enabled: true, tls: { enabled: false, inner: { deep: true } } }),
    ).toBe("enabled = true\n\n[tls]\nenabled = false\n[tls.inner]\ndeep = true\n");
  });

  it("escapes control characters in strings", () => {
    const fields: ReadonlyArray<TomlField> = [{ key: "s", node: { kind: "string" } }];
    expect(encodeToml(fields, { s: 'a"b\\c\nd' })).toBe('s = "a\\"b\\\\c\\nd"\n');
  });

  it("sorts map keys and renders a set as empty sub-tables", () => {
    // A leading primitive forces `hasWritten`, so the depth-1 blank line before
    // the table header is emitted (it is suppressed when nothing precedes it).
    const mapFields: ReadonlyArray<TomlField> = [
      { key: "enabled", node: { kind: "bool" } },
      { key: "vault", node: { kind: "map", value: { kind: "string" } } },
    ];
    expect(encodeToml(mapFields, { enabled: true, vault: { b: "2", a: "1" } })).toBe(
      'enabled = true\n\n[vault]\na = "1"\nb = "2"\n',
    );

    const setFields: ReadonlyArray<TomlField> = [
      { key: "enabled", node: { kind: "bool" } },
      { key: "buckets", node: { kind: "set" } },
    ];
    expect(encodeToml(setFields, { enabled: true, buckets: ["z", "a"] })).toBe(
      "enabled = true\n\n[buckets]\n[buckets.a]\n[buckets.z]\n",
    );
  });
});
