import { describe, expect, test } from "vitest";
import * as SmolToml from "smol-toml";
import {
  applyConfigEdits,
  type AppliedConfigEdit,
  type ConfigEdit,
  type ConfigEditOutcome,
} from "./config-edit.ts";

function applied(outcome: ConfigEditOutcome): {
  text: string;
  applied: ReadonlyArray<AppliedConfigEdit>;
} {
  if (outcome.kind !== "applied") {
    throw new Error(`expected an applied outcome, got a refusal: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function refusalReason(outcome: ConfigEditOutcome): string {
  if (outcome.kind !== "refused") {
    throw new Error(`expected a refused outcome, got: ${JSON.stringify(outcome)}`);
  }
  return outcome.refusal.reason;
}

describe("applyConfigEdits (toml): replace", () => {
  test("replaces a scalar value in place, leaving comments and surrounding lines untouched", () => {
    const source = `# top comment
project_id = "demo"

[api]
enabled = true
# doc
max_rows = 1000

[db]
port = 54322
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["api", "max_rows"], value: 500 }]);
    expect(outcome.kind).toBe("applied");
    expect(applied(outcome).text).toBe(`# top comment
project_id = "demo"

[api]
enabled = true
# doc
max_rows = 500

[db]
port = 54322
`);
  });

  test("replaces a dotted-key scalar in place", () => {
    const source = `[a]
b.c = 1
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "b", "c"], value: 2 }]);
    expect(applied(outcome).text).toBe(`[a]
b.c = 2
`);
    expect(applied(outcome).applied).toEqual([
      { path: ["a", "b", "c"], action: "replaced", createdTables: [] },
    ]);
  });

  test("rewrites a multi-line array single-line, only touching the value span", () => {
    const source = `[db.network_restrictions]
allowed_cidrs = [
  "0.0.0.0/0",
  # comment inside array
  "10.0.0.0/8",
]
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["db", "network_restrictions", "allowed_cidrs"], value: ["1.2.3.4/32"] },
    ]);
    expect(applied(outcome).text).toBe(`[db.network_restrictions]
allowed_cidrs = ["1.2.3.4/32"]
`);
  });

  test("preserves an unrelated literal string elsewhere in the file untouched", () => {
    const source = "[a]\npath = 'C:\\Users\\me'\nx = 1\n";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "x"], value: 2 }]);
    expect(applied(outcome).text).toBe("[a]\npath = 'C:\\Users\\me'\nx = 2\n");
  });

  test("round-trips backslashes and quotes through basic-string escaping", () => {
    const source = "[a]\nx = 1\n";
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["a", "y"], value: 'back\\slash and "quote"' },
    ]);
    const text = applied(outcome).text;
    expect(text).toBe('[a]\nx = 1\ny = "back\\\\slash and \\"quote\\""\n');
    expect(SmolToml.parse(text)).toEqual({ a: { x: 1, y: 'back\\slash and "quote"' } });
  });
});

describe("applyConfigEdits (toml): insert", () => {
  test("inserts a new key right after the last key of an existing table, before a trailing comment that belongs to the next header", () => {
    const source = `[a]
x = 1
# doc for b
[b]
y = 2
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "z"], value: 9 }]);
    expect(applied(outcome).text).toBe(`[a]
x = 1
z = 9
# doc for b
[b]
y = 2
`);
    expect(applied(outcome).applied).toEqual([
      { path: ["a", "z"], action: "inserted", createdTables: [] },
    ]);
  });

  test("inserts a sibling dotted key next to an existing dotted-key-only parent, never synthesizing a header", () => {
    const source = `[a]
b.c = 1
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "b", "d"], value: 2 }]);
    expect(applied(outcome).text).toBe(`[a]
b.c = 1
b.d = 2
`);
  });

  test("creates a missing table after the last table sharing the longest path prefix", () => {
    const source = `[auth]
enabled = true

[auth.sms]
enable_signup = false

[auth.sms.twilio]
enabled = false

[auth.mfa]
max_enrolled_factors = 10
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["auth", "sms", "test_otp", "+15551234"], value: "123456" },
    ]);
    expect(applied(outcome).text).toBe(`[auth]
enabled = true

[auth.sms]
enable_signup = false

[auth.sms.twilio]
enabled = false

[auth.sms.test_otp]
"+15551234" = "123456"

[auth.mfa]
max_enrolled_factors = 10
`);
    expect(applied(outcome).applied).toEqual([
      {
        path: ["auth", "sms", "test_otp", "+15551234"],
        action: "inserted",
        createdTables: [["auth", "sms", "test_otp"]],
      },
    ]);
  });

  test("inserts a missing table at EOF when no existing table shares any path prefix", () => {
    const source = `project_id = "demo"

[api]
max_rows = 1000
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["storage", "buckets", "images", "public"], value: false },
    ]);
    expect(applied(outcome).text).toBe(`project_id = "demo"

[api]
max_rows = 1000

[storage.buckets.images]
public = false
`);
  });

  test("creates a brand new [remotes.<label>] block at EOF with a blank line before it and project_id first, regardless of edit order", () => {
    const source = `project_id = "demo"

[api]
max_rows = 1000

[remotes.other]
project_id = "aaaaaaaaaaaaaaaaaaaa"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "staging", "api", "max_rows"], value: 900 },
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(applied(outcome).text).toBe(`project_id = "demo"

[api]
max_rows = 1000

[remotes.other]
project_id = "aaaaaaaaaaaaaaaaaaaa"

[remotes.staging]
project_id = "bbbbbbbbbbbbbbbbbbbb"

[remotes.staging.api]
max_rows = 900
`);
    expect(applied(outcome).applied).toEqual([
      {
        path: ["remotes", "staging", "api", "max_rows"],
        action: "inserted",
        createdTables: [
          ["remotes", "staging"],
          ["remotes", "staging", "api"],
        ],
      },
      {
        path: ["remotes", "staging", "project_id"],
        action: "inserted",
        createdTables: [["remotes", "staging"]],
      },
    ]);
  });

  test("quotes a table label and a key that aren't bare-safe", () => {
    const source = 'project_id = "demo"\n';
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "feature/login", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    const text = applied(outcome).text;
    expect(text).toBe(
      'project_id = "demo"\n\n[remotes."feature/login"]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n',
    );
    expect(SmolToml.parse(text)).toEqual({
      project_id: "demo",
      remotes: { "feature/login": { project_id: "bbbbbbbbbbbbbbbbbbbb" } },
    });

    const otpSource = "[auth.sms]\nenabled = true\n";
    const otpOutcome = applyConfigEdits(otpSource, "toml", [
      { path: ["auth", "sms", "test_otp", "+15551234"], value: "123456" },
    ]);
    expect(applied(otpOutcome).text).toContain('"+15551234" = "123456"');
  });
});

describe("applyConfigEdits (toml): refusals", () => {
  test("refuses a document with a duplicate table header", () => {
    const source = `[api]
x = 1
[api]
y = 2
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["api", "x"], value: 2 }]);
    expect(refusalReason(outcome)).toBe("duplicate_table_header");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.path).toEqual(["api"]);
    }
  });

  test("refuses editing through an array-of-tables path", () => {
    const source = `[[remotes]]
project_id = "aaaaaaaaaaaaaaaaaaaa"
[[remotes]]
project_id = "bbbbbbbbbbbbbbbbbbbb"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "project_id"], value: "x" },
    ]);
    expect(refusalReason(outcome)).toBe("array_of_tables_on_path");
  });

  test("refuses editing through an inline table", () => {
    const source = "x = { a = 1 }\n";
    expect(refusalReason(applyConfigEdits(source, "toml", [{ path: ["x", "a"], value: 2 }]))).toBe(
      "inline_table_on_path",
    );
    expect(
      refusalReason(applyConfigEdits(source, "toml", [{ path: ["x"], value: { a: 5 } }])),
    ).toBe("inline_table_on_path");
  });

  test("refuses replacing a destination that already holds an env() reference", () => {
    const source = `[auth.sms.twilio]
auth_token = "env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["auth", "sms", "twilio", "auth_token"], value: "literal" },
    ]);
    expect(refusalReason(outcome)).toBe("env_reference_target");
  });

  test("refuses a document it cannot parse", () => {
    const outcome = applyConfigEdits('x = "unterminated\n', "toml", [{ path: ["x"], value: "y" }]);
    expect(refusalReason(outcome)).toBe("parse_error");
  });
});

describe("applyConfigEdits (toml): newline and idempotence", () => {
  test("uses CRLF for newly inserted lines when the source is CRLF", () => {
    const source = "[api]\r\nmax_rows = 1000\r\n";
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(applied(outcome).text).toBe(
      '[api]\r\nmax_rows = 1000\r\n\r\n[remotes.staging]\r\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\r\n',
    );
  });

  test("a source with no trailing newline stays that way when only replacing", () => {
    const source = "[api]\nmax_rows = 1000";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["api", "max_rows"], value: 5 }]);
    expect(applied(outcome).text).toBe("[api]\nmax_rows = 5");
  });

  test("a source with no trailing newline gets one repaired before EOF-inserted content", () => {
    const source = "[api]\nmax_rows = 1000";
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(applied(outcome).text).toBe(
      '[api]\nmax_rows = 1000\n\n[remotes.staging]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n',
    );
  });

  test("applying the same edits to the already-edited text is byte-identical (idempotent)", () => {
    const source = `project_id = "demo"

[api]
max_rows = 1000
`;
    const edits: ReadonlyArray<ConfigEdit> = [
      { path: ["remotes", "staging", "api", "max_rows"], value: 900 },
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ];
    const first = applyConfigEdits(source, "toml", edits);
    const second = applyConfigEdits(applied(first).text, "toml", edits);
    expect(applied(second).text).toBe(applied(first).text);
    expect(applied(second).applied).toEqual([
      { path: ["remotes", "staging", "api", "max_rows"], action: "replaced", createdTables: [] },
      { path: ["remotes", "staging", "project_id"], action: "replaced", createdTables: [] },
    ]);
  });
});

describe("applyConfigEdits (toml): full realistic config.toml golden", () => {
  const source = `# For detailed configuration reference documentation, visit:
# https://supabase.com/docs/guides/local-development/cli/config
project_id = "demo"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
max_rows = 1000

[db]
port = 54322
major_version = 17

[db.pooler]
enabled = false
port = 54329

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"

[auth.sms]
enable_signup = false

[auth.sms.twilio]
enabled = false
account_sid = ""

[auth.mfa]
max_enrolled_factors = 10
`;

  test("applies a representative multi-section edit set and matches the golden output exactly", () => {
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["api", "max_rows"], value: 500 },
      { path: ["db", "pooler", "max_client_conn"], value: 100 },
      { path: ["auth", "sms", "test_otp", "+15551234"], value: "123456" },
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(applied(outcome).text).toBe(`# For detailed configuration reference documentation, visit:
# https://supabase.com/docs/guides/local-development/cli/config
project_id = "demo"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
max_rows = 500

[db]
port = 54322
major_version = 17

[db.pooler]
enabled = false
port = 54329
max_client_conn = 100

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"

[auth.sms]
enable_signup = false

[auth.sms.twilio]
enabled = false
account_sid = ""

[auth.sms.test_otp]
"+15551234" = "123456"

[auth.mfa]
max_enrolled_factors = 10

[remotes.staging]
project_id = "bbbbbbbbbbbbbbbbbbbb"
`);
  });
});

describe("applyConfigEdits (json)", () => {
  test("replaces a value, inserts a new nested path, preserves indent and key order, appends new top-level keys", () => {
    const source = `{
    "$schema": "s",
    "api": {
        "max_rows": 1000
    },
    "db": {
        "port": 5
    }
}
`;
    const outcome = applyConfigEdits(source, "json", [
      { path: ["api", "max_rows"], value: 500 },
      { path: ["auth", "site_url"], value: "http://x" },
    ]);
    expect(applied(outcome).text).toBe(`{
    "$schema": "s",
    "api": {
        "max_rows": 500
    },
    "db": {
        "port": 5
    },
    "auth": {
        "site_url": "http://x"
    }
}
`);
    expect(applied(outcome).applied).toEqual([
      { path: ["api", "max_rows"], action: "replaced", createdTables: [] },
      { path: ["auth", "site_url"], action: "inserted", createdTables: [] },
    ]);
  });

  test("detects a 2-space indent by default and a tab indent when that's what the file uses", () => {
    const twoSpace = `{\n  "api": {\n    "max_rows": 1000\n  }\n}\n`;
    const twoSpaceOut = applyConfigEdits(twoSpace, "json", [
      { path: ["api", "max_rows"], value: 2 },
    ]);
    expect(applied(twoSpaceOut).text).toBe(`{\n  "api": {\n    "max_rows": 2\n  }\n}\n`);

    const tabbed = `{\n\t"api": {\n\t\t"max_rows": 1000\n\t}\n}\n`;
    const tabbedOut = applyConfigEdits(tabbed, "json", [{ path: ["api", "max_rows"], value: 2 }]);
    expect(applied(tabbedOut).text).toBe(`{\n\t"api": {\n\t\t"max_rows": 2\n\t}\n}\n`);
  });

  test("a no-op edit (value already matches) returns the source byte-identical, without reformatting", () => {
    const source = `{
    "$schema":     "s",
    "api": { "max_rows": 1000 }
}
`;
    const outcome = applyConfigEdits(source, "json", [{ path: ["api", "max_rows"], value: 1000 }]);
    expect(applied(outcome).text).toBe(source);
    expect(applied(outcome).applied).toEqual([
      { path: ["api", "max_rows"], action: "replaced", createdTables: [] },
    ]);
  });

  test("refuses replacing a destination that already holds an env() reference", () => {
    const source = `{"studio": {"openai_api_key": "env(OPENAI_API_KEY)"}}\n`;
    const outcome = applyConfigEdits(source, "json", [
      { path: ["studio", "openai_api_key"], value: "literal" },
    ]);
    expect(refusalReason(outcome)).toBe("env_reference_target");
  });

  test("refuses a document it cannot parse", () => {
    const outcome = applyConfigEdits("{not json", "json", [{ path: ["x"], value: "y" }]);
    expect(refusalReason(outcome)).toBe("parse_error");
  });
});

describe("applyConfigEdits (toml): no-op", () => {
  test("a no-op edit (value already matches) returns the source byte-identical", () => {
    const source = `[api]
max_rows = 1000
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["api", "max_rows"], value: 1000 }]);
    expect(applied(outcome).text).toBe(source);
    expect(applied(outcome).applied).toEqual([
      { path: ["api", "max_rows"], action: "replaced", createdTables: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Randomized property test: `SmolToml.parse(apply(source, edits).text)` must deep-equal an
// independently computed `deepSet(SmolToml.parse(source), edits)` whenever the outcome is
// "applied" (a "refused" outcome is accepted as-is — it's `applyConfigEdits`'s own internal
// verification declining rather than shipping something unverified). Seeded PRNG so a failure
// reproduces: the seed is printed in the thrown error.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Independent (from `config-edit.ts`'s own `deepSet`) recursive path-set, used only to build
 * this property test's expected value. Property-test fixtures never contain TOML dates, so a
 * plain structural copy is sufficient here. */
function applyPathSet(root: unknown, path: ReadonlyArray<string>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  const base: Record<string, unknown> = isRecord(root) ? { ...root } : {};
  base[head] = applyPathSet(base[head], path.slice(1), value);
  return base;
}

function collectLeafPaths(
  value: unknown,
  prefix: ReadonlyArray<string> = [],
): Array<{ path: Array<string>; value: unknown }> {
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      collectLeafPaths(child, [...prefix, key]),
    );
  }
  return prefix.length > 0 ? [{ path: [...prefix], value }] : [];
}

function randomValueLike(
  existing: unknown,
  rand: () => number,
): string | number | boolean | Array<string> {
  if (typeof existing === "number") {
    return Math.floor(rand() * 1000);
  }
  if (typeof existing === "boolean") {
    return rand() > 0.5;
  }
  if (Array.isArray(existing)) {
    return [`item-${Math.floor(rand() * 1000)}`, `item-${Math.floor(rand() * 1000)}`];
  }
  return `random-${Math.floor(rand() * 1_000_000)}`;
}

const PROPERTY_FIXTURES: ReadonlyArray<string> = [
  `project_id = "demo"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
max_rows = 1000

[db]
port = 54322
major_version = 17
`,
  `[db.pooler]
enabled = false
port = 54329
pool_mode = "transaction"

[db.network_restrictions]
enabled = false
allowed_cidrs = ["0.0.0.0/0"]
`,
  `[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["https://127.0.0.1:3000"]

[auth.sms]
enable_signup = false

[auth.sms.twilio]
enabled = false
account_sid = ""
`,
  `[storage]
enabled = true
file_size_limit = "50MiB"

[storage.s3_protocol]
enabled = true

[remotes.staging]
project_id = "aaaaaaaaaaaaaaaaaaaa"
`,
  `[analytics]
enabled = true
port = 54327
backend = "postgres"

[experimental.pgdelta]
enabled = true
`,
];

describe("applyConfigEdits (toml): randomized property test", () => {
  test("SmolToml.parse(apply(source, edits).text) deep-equals deepSet(parse(source), edits) over 200 random edit sets", () => {
    const seed = 0x5eed_2064;
    const rand = mulberry32(seed);
    const knownRefusalReasons = new Set([
      "duplicate_table_header",
      "array_of_tables_on_path",
      "inline_table_on_path",
      "env_reference_target",
      "verification_mismatch",
      "parse_error",
    ]);

    for (let iteration = 0; iteration < 200; iteration++) {
      const fixtureIndex = Math.floor(rand() * PROPERTY_FIXTURES.length);
      const fixture = PROPERTY_FIXTURES[fixtureIndex];
      if (fixture === undefined) {
        continue;
      }
      const parsed = SmolToml.parse(fixture);
      const leaves = collectLeafPaths(parsed);
      if (leaves.length === 0) {
        continue;
      }

      const editCount = 1 + Math.floor(rand() * 3);
      const edits: Array<ConfigEdit> = [];
      for (let e = 0; e < editCount; e++) {
        const leaf = leaves[Math.floor(rand() * leaves.length)];
        if (leaf === undefined) {
          continue;
        }
        const isInsert = rand() > 0.7;
        const path = isInsert ? [...leaf.path, `extra_${Math.floor(rand() * 1000)}`] : leaf.path;
        const value = isInsert
          ? `inserted-${Math.floor(rand() * 1000)}`
          : randomValueLike(leaf.value, rand);
        edits.push({ path, value });
      }
      if (edits.length === 0) {
        continue;
      }

      try {
        const outcome = applyConfigEdits(fixture, "toml", edits);
        if (outcome.kind === "refused") {
          expect(knownRefusalReasons.has(outcome.refusal.reason)).toBe(true);
          continue;
        }
        const reparsed = SmolToml.parse(outcome.text);
        const expected = edits.reduce<unknown>(
          (acc, edit) => applyPathSet(acc, edit.path, edit.value),
          parsed,
        );
        expect(reparsed).toEqual(expected);
      } catch (error) {
        throw new Error(
          `property test failed at iteration ${iteration} (seed ${seed}, fixtureIndex ${fixtureIndex}, edits ${JSON.stringify(edits)}): ${String(error)}`,
        );
      }
    }
  });
});
