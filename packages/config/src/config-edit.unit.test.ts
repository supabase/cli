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

  // Regression coverage for CLI-2064 review finding 1: `scanBareValue` used to include
  // trailing inline whitespace before a `#` comment in the replaced value span, so replacing
  // `port = 54321 # comment` silently ate the space and produced `port = 54322# comment`. The
  // mandatory re-parse can't catch this — TOML parses the value identically either way.
  test("replacing a bare number keeps exactly the original single space before a trailing comment", () => {
    const source = "[db]\nport = 54321 # default port\n";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["db", "port"], value: 54322 }]);
    expect(applied(outcome).text).toBe("[db]\nport = 54322 # default port\n");
  });

  test("replacing a bare boolean preserves multiple spaces of original spacing before a trailing comment", () => {
    const source = "[api]\nenabled = true    # toggle me\n";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["api", "enabled"], value: false }]);
    expect(applied(outcome).text).toBe("[api]\nenabled = false    # toggle me\n");
  });

  test("replacing a bare number preserves a tab before a trailing comment", () => {
    const source = "[db]\nport = 54321\t# tab before comment\n";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["db", "port"], value: 54322 }]);
    expect(applied(outcome).text).toBe("[db]\nport = 54322\t# tab before comment\n");
  });

  test("replacing a bare value with no space before its trailing comment stays that way", () => {
    const source = "[db]\nport = 54321# no space\n";
    const outcome = applyConfigEdits(source, "toml", [{ path: ["db", "port"], value: 54322 }]);
    expect(applied(outcome).text).toBe("[db]\nport = 54322# no space\n");
  });

  // Pin test: a string value is already terminated by its closing quote, so the trailing
  // whitespace before `#` was never part of `scanBasicString`'s span — unaffected by this bug
  // or its fix either way.
  test("replacing a string value with a trailing comment is unaffected (already quote-terminated)", () => {
    const source = '[a]\nname = "old" # a name\n';
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "name"], value: "new" }]);
    expect(applied(outcome).text).toBe('[a]\nname = "new" # a name\n');
  });

  // Pin test: replacing an EXISTING root-level (single-segment) key must keep working —
  // finding 6's new refusal only targets an INSERT at that same shape (no exact key match).
  test("replaces an existing root-level single-segment key in place", () => {
    const source = 'project_id = "demo"\n\n[api]\nenabled = true\n';
    const outcome = applyConfigEdits(source, "toml", [{ path: ["project_id"], value: "updated" }]);
    expect(applied(outcome).text).toBe('project_id = "updated"\n\n[api]\nenabled = true\n');
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

  // Regression coverage for CLI-2064 review finding: the dotted-sibling search used to accept
  // ANY key-value declared below the insert's parent, including one living inside a genuine
  // DESCENDANT table header (not a dotted-key-only parent) — here `host` inside
  // `[auth.email.smtp]` when inserting under `auth.email`. That produced an enclosing length
  // longer than the leaf path itself and spliced in an empty, keyless ` = true` line, refused
  // only by mandatory re-parse verification. The fix requires the candidate's ENCLOSING TABLE to
  // be a prefix of the insert's parent (an ancestor, reached via dotted-key assignment) — a
  // descendant table like `[auth.email.smtp]` no longer qualifies, so this falls through to
  // ordinary missing-table placement instead, creating `[auth.email]` right after the table it
  // shares the longest path prefix with (TOML permits declaring a super-table after its
  // sub-table).
  test("creates the missing parent table instead of a bogus dotted sibling when only a descendant table exists", () => {
    const source = `[auth.email.smtp]
host = "smtp.example.com"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["auth", "email", "enable_confirmations"], value: true },
    ]);
    expect(applied(outcome).text).toBe(`[auth.email.smtp]
host = "smtp.example.com"

[auth.email]
enable_confirmations = true
`);
    expect(applied(outcome).applied).toEqual([
      {
        path: ["auth", "email", "enable_confirmations"],
        action: "inserted",
        createdTables: [["auth", "email"]],
      },
    ]);
  });

  test("prefers a dotted-sibling insert over a descendant table when the parent has both", () => {
    const source = `[auth]
email.something = 1

[auth.email.smtp]
host = "smtp.example.com"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["auth", "email", "enable_confirmations"], value: true },
    ]);
    expect(applied(outcome).text).toBe(`[auth]
email.something = 1
email.enable_confirmations = true

[auth.email.smtp]
host = "smtp.example.com"
`);
    expect(applied(outcome).applied).toEqual([
      { path: ["auth", "email", "enable_confirmations"], action: "inserted", createdTables: [] },
    ]);
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

  // Regression coverage for CLI-2064 review finding 5: inserting a new key into a table whose
  // existing keys are indented used to write the new line flush-left instead of matching.
  test("inserts a new key into an indented table matching the indentation of the key it follows", () => {
    const source = `[a]
  x = 1
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "y"], value: 2 }]);
    expect(applied(outcome).text).toBe(`[a]
  x = 1
  y = 2
`);
  });

  test("a key inserted into a currently-empty table stays flush-left (no sibling to copy indentation from)", () => {
    const source = `[a]

[b]
  x = 1
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a", "z"], value: 9 }]);
    expect(applied(outcome).text).toBe(`[a]
z = 9

[b]
  x = 1
`);
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

  // Regression coverage for CLI-2064 review finding 6: a root-level single-segment path with
  // no existing exact key (an INSERT, not a replace) used to fall into the "dotted sibling"
  // placement branch — trivially true for every key in the document, since an empty path is a
  // prefix of everything — and splice in a keyless ` = value` line that only the mandatory
  // re-parse caught. This is now refused up front instead.
  test("refuses inserting a brand-new root-level (single-segment) key", () => {
    const source = 'project_id = "demo"\n\n[api]\nenabled = true\n';
    const outcome = applyConfigEdits(source, "toml", [{ path: ["new_top_level_key"], value: 1 }]);
    expect(refusalReason(outcome)).toBe("verification_mismatch");
  });

  // Regression/documentation coverage for CLI-2064 review finding 7: `deepSet` (the mandatory
  // verification oracle) REPLACES a destination table wholesale with an object-valued edit's
  // value, while the actual written text only ever touches the leaves the object mentions —
  // so an object edit that omits an existing sibling key verify-mismatches instead of merging.
  test("refuses an object-valued edit that omits an existing sibling key of the destination table", () => {
    const source = `[a]
x = 1
y = 2
`;
    const outcome = applyConfigEdits(source, "toml", [{ path: ["a"], value: { x: 99 } }]);
    expect(refusalReason(outcome)).toBe("verification_mismatch");
  });

  // Regression pin: the TOML arm already refused this shape before the JSON arm was brought in
  // line with it (config-edit.ts's JSON-arm consistency fix) — this test just confirms TOML's
  // own behavior didn't move. Same shape as the JSON refusal test below, with the omitted
  // sibling spelled as an `env(...)` reference (an exfiltration-adjacent flavor: the omitted
  // sibling is exactly the kind of value that must never be silently dropped from the file).
  test("refuses a TOML object-valued edit that would delete an existing env() sibling", () => {
    const source = `[auth.sms.test_otp]
"+15551234" = "111111"
"+15559999" = "env(OTP_FALLBACK)"
`;
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["auth", "sms", "test_otp"], value: { "+15551234": "888888" } },
    ]);
    expect(refusalReason(outcome)).toBe("verification_mismatch");
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

  // Regression coverage for CLI-2064 review finding 3: `endsWithNewline` used to check
  // `source.endsWith(newline)`, where `newline` is CRLF as soon as the file contains one
  // anywhere. A mixed-EOL file whose LAST line ends in a bare `\n` (not preceded by `\r`)
  // doesn't end with `"\r\n"`, so this read as "no trailing newline" and doubled the EOF
  // terminator ahead of an EOF-inserted block.
  test("a mixed-EOL file whose last line ends in a bare LF gets exactly one blank line before EOF-inserted content, not two", () => {
    const source = "[api]\r\nmax_rows = 1000\n";
    const outcome = applyConfigEdits(source, "toml", [
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(applied(outcome).text).toBe(
      '[api]\r\nmax_rows = 1000\n\r\n[remotes.staging]\r\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\r\n',
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

  // Regression coverage for CLI-2064 review finding 4: `JSON.stringify` always renders `\n`, so
  // this used to silently flip a CRLF-flavored JSON config to LF on every edit.
  test("preserves CRLF line endings and a trailing newline", () => {
    const source = '{\r\n  "api": {\r\n    "max_rows": 1000\r\n  }\r\n}\r\n';
    const outcome = applyConfigEdits(source, "json", [{ path: ["api", "max_rows"], value: 2 }]);
    expect(applied(outcome).text).toBe('{\r\n  "api": {\r\n    "max_rows": 2\r\n  }\r\n}\r\n');
  });

  test("preserves CRLF line endings with no trailing newline", () => {
    const source = '{\r\n  "api": {\r\n    "max_rows": 1000\r\n  }\r\n}';
    const outcome = applyConfigEdits(source, "json", [{ path: ["api", "max_rows"], value: 2 }]);
    expect(applied(outcome).text).toBe('{\r\n  "api": {\r\n    "max_rows": 2\r\n  }\r\n}');
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

  // Regression coverage for the JSON-arm consistency fix: before it, an object-valued edit was
  // mutated AND verified with the same whole-subtree-replacing `deepSet`, so it could never
  // catch itself deleting an unmentioned sibling — here, an `env(...)` reference, the exact kind
  // of value this module must never silently drop. The TOML arm already refused this shape (see
  // the pinned regression test in the `toml` describe block above); this is the JSON equivalent.
  test("refuses a JSON object-valued edit that would delete an existing env() sibling, leaving the source untouched", () => {
    const source = `{
    "auth": {
        "sms": {
            "test_otp": {
                "+15551234": "111111",
                "+15559999": "env(OTP_FALLBACK)"
            }
        }
    }
}
`;
    const outcome = applyConfigEdits(source, "json", [
      { path: ["auth", "sms", "test_otp"], value: { "+15551234": "888888" } },
    ]);
    expect(refusalReason(outcome)).toBe("verification_mismatch");
    expect(outcome.kind).toBe("refused");
  });

  // Companion case: an object-valued edit that mentions EVERY existing sibling key has nothing
  // left to delete, so it merges cleanly — writing only the mentioned leaves and preserving the
  // destination's OWN key order (not the edit value's own key order, which lists them reversed).
  test("merges a JSON object-valued edit that omits no existing sibling, writing mentioned leaves and preserving key order", () => {
    const source = `{
    "auth": {
        "sms": {
            "test_otp": {
                "+15551234": "111111",
                "+15559999": "222222"
            }
        }
    }
}
`;
    const outcome = applyConfigEdits(source, "json", [
      {
        path: ["auth", "sms", "test_otp"],
        value: { "+15559999": "999999", "+15551234": "888888" },
      },
    ]);
    expect(applied(outcome).text).toBe(`{
    "auth": {
        "sms": {
            "test_otp": {
                "+15551234": "888888",
                "+15559999": "999999"
            }
        }
    }
}
`);
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
// Randomized property test. For every random edit set that `applyConfigEdits` accepts, asserts:
//
//  (a) BYTE PRESERVATION — every source line whose span doesn't intersect an edited key's own
//      line appears verbatim, in order, in the output; a REPLACED key's line is held to a
//      narrower standard (its `key = ` prefix and any trailing `#comment` — including the
//      whitespace right before it — must survive unchanged, only the value between them may
//      differ), since that's the one span the editor is actually allowed to touch. This is the
//      check that would have caught finding 1 (comment-eating): the ORIGINAL, tautological
//      version of this test only compared PARSED values, which are identical either way.
//  (b) IDEMPOTENCE — re-applying the same edits to the already-edited text is a no-op
//      (byte-identical to the first result).
//  (c) ZERO REFUSALS — these fixtures/edits never hit a refusal-triggering construct (no
//      duplicate headers, arrays-of-tables, inline tables, or existing `env()` values), so an
//      "applied" outcome is required, not merely accepted; a refusal here means either a fixture
//      accidentally exercises one of those constructs, or a real regression.
//  (d) the original PARSE-EQUIVALENCE oracle — `SmolToml.parse(apply(source, edits).text)` must
//      deep-equal an independently computed `deepSet(SmolToml.parse(source), edits)`. Still a
//      valid oracle (it does catch structural mistakes), just not a SUFFICIENT one on its own —
//      see (a) above.
//
// Seeded PRNG so a failure reproduces: the seed is printed in every thrown error.
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

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
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
  // Rich in trailing inline comments on bare (non-string) values, deliberately varying the
  // whitespace before `#` (single space / multiple spaces / none) — this is the fixture shape
  // that would have caught finding 1, via the byte-preservation check below.
  `[db]
port = 54322 # default port, don't change carelessly
major_version = 17   # postgres version

[db.pooler]
enabled = false  # pooler toggle
max_client_conn = 100# no space before this comment
`,
];

/** A line, as read off one of `PROPERTY_FIXTURES` verbatim, and — for a key-value line — the
 * fully qualified path it declares. Deliberately INDEPENDENT of `config-edit.ts`'s own scanner:
 * these fixtures never contain indented keys, dotted-key assignments, quoted keys/headers, or
 * multi-line values, so a full TOML scanner isn't needed to know which physical line each
 * key-value pair lives on — only used to build the byte-preservation oracle below. */
interface FixtureLine {
  readonly text: string;
  readonly path?: ReadonlyArray<string>;
}

function describeFixtureLines(source: string): ReadonlyArray<FixtureLine> {
  let currentTablePath: ReadonlyArray<string> = [];
  return source.split("\n").map((line) => {
    const headerMatch = /^\[([^[\]]+)\]$/.exec(line);
    if (headerMatch?.[1] !== undefined) {
      currentTablePath = headerMatch[1].split(".");
      return { text: line };
    }
    const keyMatch = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (keyMatch?.[1] === undefined) {
      return { text: line };
    }
    return { text: line, path: [...currentTablePath, keyMatch[1]] };
  });
}

/** Splits a key-value line into its `key = ` prefix and, if present, its trailing comment —
 * INCLUDING whichever run of spaces/tabs immediately precedes the `#`, since that's exactly the
 * span finding 1's bug used to eat. */
function splitKvLineSuffix(line: string): { prefix: string; commentSuffix: string | undefined } {
  const prefixMatch = /^([A-Za-z0-9_-]+\s*=\s*)/.exec(line);
  const prefix = prefixMatch?.[1] ?? "";
  const rest = line.slice(prefix.length);
  const hashIndex = rest.indexOf("#");
  if (hashIndex === -1) {
    return { prefix, commentSuffix: undefined };
  }
  let start = hashIndex;
  while (start > 0 && (rest[start - 1] === " " || rest[start - 1] === "\t")) {
    start--;
  }
  return { prefix, commentSuffix: rest.slice(start) };
}

/** Asserts property (a): every `sourceLines` entry appears, in order, in `outputText` — exactly
 * (for a line whose path isn't in `replacedPathKeys`) or matching just its `key = ` prefix and
 * trailing comment (for a line whose path IS in `replacedPathKeys`, since only its value may
 * differ). Throws with a descriptive message on the first violation. */
function assertLinePreservation(
  sourceLines: ReadonlyArray<FixtureLine>,
  replacedPathKeys: ReadonlySet<string>,
  outputText: string,
): void {
  const outputLines = outputText.split("\n");
  let pointer = 0;
  for (const line of sourceLines) {
    if (line.path !== undefined && replacedPathKeys.has(pathKey(line.path))) {
      const { prefix, commentSuffix } = splitKvLineSuffix(line.text);
      const foundIndex = outputLines.findIndex(
        (candidate, index) =>
          index >= pointer &&
          candidate.startsWith(prefix) &&
          (commentSuffix === undefined || candidate.endsWith(commentSuffix)),
      );
      if (foundIndex === -1) {
        throw new Error(
          `expected a replaced line matching prefix ${JSON.stringify(prefix)}` +
            (commentSuffix === undefined
              ? ""
              : ` and trailing comment ${JSON.stringify(commentSuffix)}`) +
            ` at or after output line ${pointer}, found none in ${JSON.stringify(outputLines)}`,
        );
      }
      pointer = foundIndex + 1;
      continue;
    }
    const foundIndex = outputLines.findIndex(
      (candidate, index) => index >= pointer && candidate === line.text,
    );
    if (foundIndex === -1) {
      throw new Error(
        `expected untouched source line ${JSON.stringify(line.text)} to survive verbatim, in ` +
          `order, at or after output line ${pointer} — byte preservation violated (output: ` +
          `${JSON.stringify(outputLines)})`,
      );
    }
    pointer = foundIndex + 1;
  }
}

describe("applyConfigEdits (toml): randomized property test", () => {
  test("byte preservation, idempotence, zero refusals, and parse-equivalence hold over 200 random edit sets", () => {
    const seed = 0x5eed_2064;
    const rand = mulberry32(seed);

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
      const existingLeafPathKeys = new Set(leaves.map((leaf) => pathKey(leaf.path)));

      const editCount = 1 + Math.floor(rand() * 3);
      const rawEdits: Array<ConfigEdit> = [];
      for (let e = 0; e < editCount; e++) {
        const leaf = leaves[Math.floor(rand() * leaves.length)];
        if (leaf === undefined) {
          continue;
        }
        // A root-level (single-segment) leaf has no enclosing table to insert a new sibling
        // key into (see finding 6's dedicated refusal test) — only ever replace it here.
        // Nesting the new key one level UNDER the leaf itself (rather than alongside it, in
        // its own enclosing table) is deliberately avoided too: a scalar leaf isn't a table,
        // so `SmolToml.parse` rejects the resulting document as redeclaring the same key as
        // both a value and a table — an unrelated, out-of-scope corner case this test isn't
        // meant to exercise.
        const canInsert = leaf.path.length > 1;
        const isInsert = canInsert && rand() > 0.7;
        const path = isInsert
          ? [...leaf.path.slice(0, -1), `extra_${Math.floor(rand() * 1000)}`]
          : leaf.path;
        const value = isInsert
          ? `inserted-${Math.floor(rand() * 1000)}`
          : randomValueLike(leaf.value, rand);
        rawEdits.push({ path, value });
      }
      if (rawEdits.length === 0) {
        continue;
      }

      // De-duplicate by path, last edit wins (matching `deepSet`'s own reduce semantics): two
      // edits at the exact same path in one call hits an unrelated, out-of-scope corner case
      // (`applySplices` applying two same-span replacements sequentially, the second using a
      // now-stale offset) that isn't one of this review's findings — avoided here so the zero-
      // refusals property stays meaningful.
      const dedupedByPath = new Map<string, ConfigEdit>();
      for (const edit of rawEdits) {
        dedupedByPath.set(pathKey(edit.path), edit);
      }
      const edits = [...dedupedByPath.values()];
      const replacedPathKeys = new Set(
        edits.map((edit) => pathKey(edit.path)).filter((key) => existingLeafPathKeys.has(key)),
      );

      try {
        const outcome = applyConfigEdits(fixture, "toml", edits);
        if (outcome.kind === "refused") {
          throw new Error(
            `expected zero refusals, got "${outcome.refusal.reason}" at path ` +
              `${JSON.stringify(outcome.refusal.path)}: ${outcome.refusal.detail}`,
          );
        }

        const reparsed = SmolToml.parse(outcome.text);
        const expected = edits.reduce<unknown>(
          (acc, edit) => applyPathSet(acc, edit.path, edit.value),
          parsed,
        );
        expect(reparsed).toEqual(expected);

        assertLinePreservation(describeFixtureLines(fixture), replacedPathKeys, outcome.text);

        const second = applyConfigEdits(outcome.text, "toml", edits);
        if (second.kind === "refused") {
          throw new Error(
            `idempotence check: re-applying the same edits refused with "${second.refusal.reason}"`,
          );
        }
        expect(second.text).toBe(outcome.text);
      } catch (error) {
        throw new Error(
          `property test failed at iteration ${iteration} (seed ${seed}, fixtureIndex ${fixtureIndex}, edits ${JSON.stringify(edits)}): ${String(error)}`,
        );
      }
    }
  });
});
