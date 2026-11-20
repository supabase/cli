import { describe, expect, test } from "vitest";
import * as SmolToml from "smol-toml";
import { CliConfigConvertError, convertCliConfigTomlToJsonc } from "./config-convert.ts";
import { convertCliConfigJsoncToToml } from "./config-convert-toml.ts";
import { parseJsonc } from "./jsonc.ts";
import { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";

const EXAMPLE_LINE = /^# (\[\[?[^\]]+\]\]?|[\w."'-]+ = .+)$/;

const INIT_FIXTURE = `# Project settings
project_id = "demo"

[api]
enabled = true
# Port to use for the API URL.
port = 54321
schemas = ["public", "graphql_public"]
# The pool size.
# db_pool = 10

[api.tls]
enabled = false
# cert_path = "../certs/my-cert.pem"

# Uncomment to configure vault.
# [db.vault]
# secret_key = "env(SECRET_VALUE)"

[db.pooler]
enabled = false
port = 54329

# Configure sessions.
# [auth.sessions]
# Force log out after the specified duration.
# timebox = "24h"

# Use pre-defined map of phone numbers.
# [auth.sms.test_otp]
# 14152127777 = "123456"

# Buckets.
# [storage.buckets.images]
# public = false
# allowed_mime_types = ["image/png", "image/jpeg"]
`;

const refusalOf = (source: string): CliConfigConvertError => {
  try {
    convertCliConfigJsoncToToml(source);
  } catch (error) {
    if (error instanceof CliConfigConvertError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a refusal");
};

const examples = (text: string) => text.split("\n").filter((line) => EXAMPLE_LINE.test(line));

describe("convertCliConfigJsoncToToml", () => {
  test("round-trips a commented init template", () => {
    const jsonc = convertCliConfigTomlToJsonc(INIT_FIXTURE).text;

    const back = convertCliConfigJsoncToToml(jsonc);

    expect(SmolToml.parse(back.text)).toEqual(SmolToml.parse(INIT_FIXTURE));
    expect(new Set(examples(back.text))).toEqual(new Set(examples(INIT_FIXTURE)));
    expect(examples(back.text)).toHaveLength(examples(INIT_FIXTURE).length);
    expect(back.movedComments).toEqual([]);
  });

  test("uses the $schema key for the directive and omits it from the keys", () => {
    const out = convertCliConfigJsoncToToml(
      '{ "$schema": "https://supabase.com/schemas/config/v1.json", "a": 1 }',
    );

    expect(out.schemaSource).toBe("key");
    expect(out.text.split("\n")[0]).toBe("#:schema https://supabase.com/schemas/config/v1.json");
    expect(SmolToml.parse(out.text)).toEqual({ a: 1 });
  });

  test("falls back to the default schema without $schema", () => {
    const out = convertCliConfigJsoncToToml('{ "a": 1 }');

    expect(out).toMatchObject({ schemaSource: "default", schemaRef: CLI_CONFIG_SCHEMA_URL });
    expect(out.text).toBe(`#:schema ${CLI_CONFIG_SCHEMA_URL}\n\na = 1\n`);
  });

  test("ignores a commented-out $schema example", () => {
    const out = convertCliConfigJsoncToToml(
      '{\n  // "$schema": "https://example.com/other.json",\n  "a": 1\n}',
    );

    expect(out).toMatchObject({ schemaSource: "default", schemaRef: CLI_CONFIG_SCHEMA_URL });
    expect(SmolToml.parse(out.text)).toEqual({ a: 1 });
  });

  test("refuses a non-string $schema", () => {
    expect(refusalOf('{ "$schema": 1 }')).toMatchObject({ reason: "unsupported_value" });
  });

  test("refuses null with its line", () => {
    expect(refusalOf('{\n  "a": {\n    "b": null\n  }\n}')).toMatchObject({
      reason: "unsupported_value",
      sourceLine: 3,
      detail: expect.stringContaining("`a.b` is null"),
    });
  });

  test("refuses an integer that loses precision as a double", () => {
    expect(refusalOf('{\n  "a": {\n    "b": 9007199254740993\n  }\n}')).toMatchObject({
      reason: "unsupported_value",
      sourceLine: 3,
      detail: expect.stringContaining("`a.b` is 9007199254740993, which is too large"),
    });
  });

  test("quotes keys that are not bare and indexes array items in the null path", () => {
    expect(refusalOf('{ "a.b": [ { "c": null } ] }')).toMatchObject({
      reason: "unsupported_value",
      detail: expect.stringContaining('`"a.b"[0].c` is null'),
    });
  });

  test("refuses syntax errors and duplicate keys as parse errors", () => {
    expect(refusalOf('{ "a": ')).toMatchObject({ reason: "parse_error" });
    expect(refusalOf('{ "a": 1, "a": 2 }')).toMatchObject({
      reason: "parse_error",
      detail: "`a` is defined twice",
    });
    expect(refusalOf("[1]")).toMatchObject({ reason: "parse_error" });
  });

  test("escapes control characters in a duplicate key refusal", () => {
    const detail = refusalOf('{ "a": { "\\u001b": 1, "\\u001b": 2 } }').detail;

    expect(detail).not.toContain("\u001b");
    expect(detail).toBe('`a."\\u001b"` is defined twice');
  });

  test("keeps a comment above a table that only holds subtables on that table", () => {
    const source = '{\n  // about db\n  "db": { "pooler": { "enabled": true } }\n}';
    const out = convertCliConfigJsoncToToml(source);

    expect(out.text).toContain("# about db\n[db]\n[db.pooler]\nenabled = true\n");
    expect(out.movedComments).toEqual([]);
    expect(SmolToml.parse(out.text)).toEqual(parseJsonc(source));
  });

  test("renders arrays of objects as arrays of tables", () => {
    const out = convertCliConfigJsoncToToml(
      '{ "hook": { "items": [ { "name": "a" }, { "name": "b", "extra": { "x": 1 } } ] } }',
    );

    expect(out.text).toContain("[[hook.items]]");
    expect(out.text).toContain("[hook.items.extra]");
    expect(SmolToml.parse(out.text)).toEqual({
      hook: { items: [{ name: "a" }, { name: "b", extra: { x: 1 } }] },
    });
  });

  test("falls back to inline tables for mixed arrays and hoists inner comments", () => {
    const out = convertCliConfigJsoncToToml(
      '{\n  "mixed": [\n    // note\n    { "a": 1 },\n    2\n  ]\n}',
    );

    expect(out.text).toContain("# note\nmixed = [{ a = 1 }, 2]");
    expect(out.movedComments).toEqual([{ line: 3, text: "// note", anchor: ["mixed"] }]);
  });

  test("keeps multi-line scalar arrays multi-line with their comments", () => {
    const out = convertCliConfigJsoncToToml(
      '{\n  "list": [\n    // first\n    "a", // inline\n    "b"\n  ]\n}',
    );

    expect(out.text).toContain('list = [\n  # first\n  "a", # inline\n  "b",\n]');
  });

  test("moves a leaf after a child table above the subtables", () => {
    const out = convertCliConfigJsoncToToml('{ "t": { "child": { "x": 1 }, "leaf": 2 } }');

    expect(out.text.indexOf("leaf = 2")).toBeLessThan(out.text.indexOf("[t.child]"));
  });

  test("records trailing comments that land before subtables as moved", () => {
    const out = convertCliConfigJsoncToToml(
      '{ "t": { "leaf": 1, "child": { "x": 1 }\n // trailing\n } }',
    );

    expect(out.movedComments).toEqual([{ line: 2, text: "// trailing", anchor: ["t"] }]);
  });

  test("quotes non-bare keys and escapes DEL", () => {
    const out = convertCliConfigJsoncToToml('{ "a.b": "x\\u007fy" }');

    expect(out.text).toContain('"a.b" = "x\\u007fy"');
    expect(SmolToml.parse(out.text)).toEqual({ "a.b": "x\u007fy" });
  });

  test("preserves CRLF line endings", () => {
    const out = convertCliConfigJsoncToToml('{\r\n  // c\r\n  "a": 1\r\n}\r\n');

    expect(out.text).toBe(`#:schema ${CLI_CONFIG_SCHEMA_URL}\r\n\r\n# c\r\na = 1\r\n`);
  });

  test("strips a BOM", () => {
    expect(SmolToml.parse(convertCliConfigJsoncToToml('﻿{ "a": 1 }').text)).toEqual({ a: 1 });
  });

  test.each([
    ['// "a": {"x": 1} // keep me', "# [a]\n# x = 1\n# keep me"],
    ['// "a": [{"x": 1}] // keep me', "# [[a]]\n# x = 1\n# keep me"],
    ['// "a": {\n  //   "x": 1\n  // } // keep me', "# [a]\n# x = 1\n# keep me"],
    ['// "a": [\n  //   {"x": 1}\n  // ] // keep me', "# [[a]]\n# x = 1\n# keep me"],
    ['// "a": 1 // keep me', "# a = 1 # keep me"],
  ])("keeps the trailing note of the commented-out example %s", (example, expected) => {
    const out = convertCliConfigJsoncToToml(`{\n  ${example}\n  "b": 1\n}`);

    expect(out.text).toContain(expected);
  });

  test("counts each source comment once, including one holding an example with a note", () => {
    const out = convertCliConfigJsoncToToml('{\n  // "a": 1 // note\n  "b": 2 // after b\n}');

    expect(out.commentCount).toBe(2);
  });

  test("renders a trailing comment after a table next to that table", () => {
    const out = convertCliConfigJsoncToToml('{\n  "a": {"x": 1}, // after a\n  "b": 1\n}');

    expect(out.text).toContain("b = 1\n\n[a]\nx = 1\n# after a\n");
    expect(out.movedComments).toEqual([]);
  });

  test("renders a trailing comment after an empty table under its header", () => {
    const out = convertCliConfigJsoncToToml('{\n  "a": {}, // note\n  "b": 1\n}');

    expect(out.text).toContain("b = 1\n\n[a]\n# note\n");
    expect(out.movedComments).toEqual([]);
  });

  test("moves a trailing comment after a table with subtables above the subtables", () => {
    const out = convertCliConfigJsoncToToml(
      '{\n  "a": {"x": 1, "sub": {"y": 2}}, // after a\n  "b": 1\n}',
    );

    expect(out.text).toContain("[a]\nx = 1\n# after a\n\n[a.sub]\ny = 2\n");
    expect(out.movedComments).toEqual([{ line: 2, text: "// after a", anchor: ["a"] }]);
  });

  test.each([
    '{\n  "auth": {\n    "external": {\n      // "apple": {\n      //   "enabled": false\n      // }\n    }\n  }\n}',
    '{\n  "storage": {\n    "enabled": true,\n    "buckets": {\n      // "images": {"public": true}\n    }\n  }\n}',
  ])("keeps a table whose only subtables are commented-out examples: %s", (source) => {
    const out = convertCliConfigJsoncToToml(source);

    expect(SmolToml.parse(out.text)).toEqual(parseJsonc(source));
  });

  test("carries a comment after the root opening brace", () => {
    expect(convertCliConfigJsoncToToml('{ // note\n  "a": 1\n}').text).toContain("# note\na = 1");
    expect(convertCliConfigJsoncToToml('{ /* note */ "a": 1 }').text).toContain("# note\na = 1");
  });

  test.each([
    '{\n  "a": [{"x": 1}] // after\n}',
    '{\n  "a": [\n    {"x": 1}\n  ], // after\n  "b": 1\n}',
  ])("carries a comment after a table array and records it as moved: %s", (source) => {
    const out = convertCliConfigJsoncToToml(source);

    expect(out.text).toContain("# after");
    expect(out.movedComments).toEqual([
      { line: expect.any(Number), text: "// after", anchor: ["a"] },
    ]);
  });

  test("records a multi-line block comment as one line", () => {
    const out = convertCliConfigJsoncToToml(
      '{\n  "mixed": [\n    /* first\n     * second */\n    { "a": 1 },\n    2\n  ]\n}',
    );

    expect(out.movedComments).toEqual([
      { line: 3, text: "/* first * second */", anchor: ["mixed"] },
    ]);
  });

  test.each([
    ['{"$schema": "./my schema.json", "a": 1}'],
    ['{"$schema": "", "a": 1}'],
    ['{"$schema": "a\\nb", "a": 1}'],
  ])("refuses a $schema the #:schema directive cannot hold: %s", (source) => {
    expect(refusalOf(source)).toMatchObject({ reason: "unsupported_value", sourceLine: 1 });
  });

  test("refuses a config nested too deeply to convert", () => {
    const source = `{${'"a":{'.repeat(10000)}"x":1${"}".repeat(10000)}}`;

    expect(refusalOf(source)).toMatchObject({
      reason: "unsupported_value",
      detail: "the config is nested too deeply to convert",
    });
  });
});
