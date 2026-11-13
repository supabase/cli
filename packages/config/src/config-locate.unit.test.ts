import { describe, expect, test } from "vitest";
import { scanCliConfigDocument } from "./config-locate.ts";

const locateCliConfigKey = (
  source: string,
  format: "toml" | "json",
  path: ReadonlyArray<string>,
  target: "key" | "value",
) => scanCliConfigDocument(source, format).locate(path, target);
import { isSecretPath } from "./lib/secret-paths.ts";

const toml = [
  "project_id = 'demo'",
  "",
  "[api]",
  "port = 54321",
  "tls.enabled = true",
  "",
  "[auth.external.github]",
  "enabled = true",
  "",
  "[db]",
  "settings = { max_connections = 10, nested = { deep = 1 } }",
  "",
  "[remotes.staging.db]",
  "port = 1",
].join("\n");

describe("locateCliConfigKey (toml)", () => {
  test("locates a key under a header", () => {
    expect(locateCliConfigKey(toml, "toml", ["api", "port"], "key")).toEqual({
      line: 4,
      column: 1,
      endLine: 4,
      endColumn: 5,
      exact: true,
    });
  });

  test("locates a value span", () => {
    expect(locateCliConfigKey(toml, "toml", ["api", "port"], "value")).toEqual({
      line: 4,
      column: 8,
      endLine: 4,
      endColumn: 13,
      exact: true,
    });
  });

  test("locates a dotted key", () => {
    expect(locateCliConfigKey(toml, "toml", ["api", "tls", "enabled"], "key")).toMatchObject({
      line: 5,
      column: 1,
      endColumn: 12,
      exact: true,
    });
  });

  test("locates keys inside an inline table", () => {
    const key = locateCliConfigKey(toml, "toml", ["db", "settings", "max_connections"], "key");
    expect(key).toMatchObject({ line: 11, exact: true });
    const line = toml.split("\n")[10] ?? "";
    expect(line.slice((key?.column ?? 0) - 1, (key?.endColumn ?? 0) - 1)).toBe("max_connections");
    const deep = locateCliConfigKey(toml, "toml", ["db", "settings", "nested", "deep"], "value");
    expect(line.slice((deep?.column ?? 0) - 1, (deep?.endColumn ?? 0) - 1)).toBe("1");
  });

  test("locates a header-only path", () => {
    const location = locateCliConfigKey(toml, "toml", ["auth", "external", "github"], "key");
    expect(location).toMatchObject({ line: 7, column: 2, exact: true });
    expect(location?.endColumn).toBe(2 + "auth.external.github".length);
  });

  test("spans a header whose quoted segment contains a closing bracket", () => {
    const header = '[storage.buckets."photos]archive"]';
    const location = locateCliConfigKey(
      `${header}\npublic = true\n`,
      "toml",
      ["storage", "buckets", "photos]archive"],
      "key",
    );
    expect(location).toMatchObject({ line: 1, column: 2, endColumn: header.length, exact: true });
  });

  test("falls back to the parent header for a missing leaf", () => {
    expect(
      locateCliConfigKey(toml, "toml", ["auth", "external", "github", "secret"], "key"),
    ).toMatchObject({
      line: 7,
      exact: false,
    });
  });

  test("falls back to the first descendant for an implicit table", () => {
    expect(locateCliConfigKey(toml, "toml", ["remotes", "staging"], "key")).toMatchObject({
      line: 13,
      exact: false,
    });
  });

  test("locates a remote path", () => {
    expect(
      locateCliConfigKey(toml, "toml", ["remotes", "staging", "db", "port"], "key"),
    ).toMatchObject({
      line: 14,
      column: 1,
      exact: true,
    });
  });

  test("returns undefined when the document cannot be scanned", () => {
    expect(locateCliConfigKey("[api\nport = 1", "toml", ["api", "port"], "key")).toBeUndefined();
  });

  test("returns undefined when nothing matches", () => {
    expect(locateCliConfigKey(toml, "toml", ["storage", "x"], "key")).toBeUndefined();
  });
});

describe("locateCliConfigKey (array of tables)", () => {
  const rules = [
    "[[experimental.inspect.rules]]",
    'query = "ok"',
    "",
    "[[experimental.inspect.rules]]",
    "query = 123",
  ].join("\n");

  test("locates a key in the entry its index names", () => {
    expect(
      locateCliConfigKey(
        rules,
        "toml",
        ["experimental", "inspect", "rules", "1", "query"],
        "value",
      ),
    ).toMatchObject({ line: 5, column: 9, exact: true });
    expect(
      locateCliConfigKey(rules, "toml", ["experimental", "inspect", "rules", "0", "query"], "key"),
    ).toMatchObject({ line: 2, column: 1, exact: true });
  });

  test("locates an entry header by index", () => {
    expect(
      locateCliConfigKey(rules, "toml", ["experimental", "inspect", "rules", "1"], "key"),
    ).toMatchObject({ line: 4, exact: true });
  });

  test("locates a sub-table of the latest entry", () => {
    const nested = ["[[a.b]]", "x = 1", "[[a.b]]", "[a.b.c]", "y = 2"].join("\n");
    expect(locateCliConfigKey(nested, "toml", ["a", "b", "1", "c", "y"], "key")).toMatchObject({
      line: 5,
      exact: true,
    });
  });

  test("locates a JSONC array entry by index", () => {
    const jsonc = '{"experimental":{"inspect":{"rules":[{"query":"ok"},{"query":123}]}}}';
    expect(
      locateCliConfigKey(
        jsonc,
        "json",
        ["experimental", "inspect", "rules", "1", "query"],
        "value",
      ),
    ).toMatchObject({ line: 1, column: 62, exact: true });
  });
});

describe("locateCliConfigKey (jsonc)", () => {
  test("locates the last of a duplicated key, as the parser keeps", () => {
    const source = '{ "api": { "port": 1, "port": 2 } }';
    const location = locateCliConfigKey(source, "json", ["api", "port"], "value");
    expect(location).toMatchObject({ line: 1, column: source.lastIndexOf("2") + 1 });
  });

  const jsonc = [
    "﻿// comment",
    "{",
    '  "api": {',
    '    "port": 54321, /* inline */',
    '    "list": [1, 2,],',
    "  },",
    "}",
  ].join("\n");

  test("locates a key and a value past comments, trailing commas and a BOM", () => {
    expect(locateCliConfigKey(jsonc, "json", ["api", "port"], "key")).toEqual({
      line: 4,
      column: 5,
      endLine: 4,
      endColumn: 11,
      exact: true,
    });
    expect(locateCliConfigKey(jsonc, "json", ["api", "port"], "value")).toEqual({
      line: 4,
      column: 13,
      endLine: 4,
      endColumn: 18,
      exact: true,
    });
  });

  test("resolves array indices", () => {
    expect(locateCliConfigKey(jsonc, "json", ["api", "list", "1"], "value")).toMatchObject({
      line: 5,
      column: 17,
      exact: true,
    });
  });

  test("falls back to the nearest existing ancestor", () => {
    expect(locateCliConfigKey(jsonc, "json", ["api", "missing"], "key")).toMatchObject({
      line: 3,
      column: 3,
      exact: false,
    });
  });
});

describe("isSecretPath", () => {
  test.each([
    ["db", "vault", "anything"],
    ["edge_runtime", "secrets", "KEY"],
    ["auth", "external", "github", "secret"],
    ["auth", "hook", "send_sms", "secrets"],
  ])("treats %s as secret", (...path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  test("does not treat a plain key as secret", () => {
    expect(isSecretPath(["api", "port"])).toBe(false);
  });
});

describe("locateCliConfigKey (spans and inline tables)", () => {
  test("a multi-line value reports its end line", () => {
    const source = ["[auth.email.smtp]", 'pass = """', "secret", '"""', 'host = "h"'].join("\n");
    expect(
      locateCliConfigKey(source, "toml", ["auth", "email", "smtp", "pass"], "value"),
    ).toMatchObject({
      line: 2,
      endLine: 4,
    });
  });

  test("a BOM-prefixed toml document locates the first header", () => {
    const source = "\uFEFF[api]\nport = 1\n";
    expect(locateCliConfigKey(source, "toml", ["api", "port"], "key")).toMatchObject({
      line: 2,
      column: 1,
      exact: true,
    });
  });

  test("an inline table ignores key-like text inside strings and prefers the outer key", () => {
    const source = 'api = { note = "port = 1", port = 2 }\n';
    const location = locateCliConfigKey(source, "toml", ["api", "port"], "value");
    expect(source.slice((location?.column ?? 0) - 1, (location?.endColumn ?? 0) - 1)).toBe("2");
  });
});

describe("locateCliConfigKey inline-table keys", () => {
  test("matches a quoted key whose escapes decode to the path segment", () => {
    const source = 'api = { "po\\u0072t" = "bad" }\n';
    const location = locateCliConfigKey(source, "toml", ["api", "port"], "value");

    expect(location?.exact).toBe(true);
    expect(source.slice((location?.column ?? 0) - 1, (location?.endColumn ?? 0) - 1)).toBe('"bad"');
  });

  test("matches the real key after a triple-quoted string that holds key-like text", () => {
    const source = 'api = { note = """x", port = "decoy", y = "z""", port = 0 }\n';
    const location = locateCliConfigKey(source, "toml", ["api", "port"], "value");

    expect(location?.exact).toBe(true);
    expect(source.slice((location?.column ?? 0) - 1, (location?.endColumn ?? 0) - 1)).toBe("0");
  });

  test.each([
    ["the closing brace on its own line", "api = { port = 0\n}\n"],
    ["a trailing comment before the newline", "api = { port = 0 # c\n}\n"],
  ])("locates a key exactly with %s", (_label, source) => {
    const location = locateCliConfigKey(source, "toml", ["api", "port"], "value");

    expect(location).toMatchObject({ line: 1, column: 16, endColumn: 17, exact: true });
  });
});

describe("locateCliConfigKey inline arrays of tables", () => {
  const textAt = (source: string, path: ReadonlyArray<string>) => {
    const location = locateCliConfigKey(source, "toml", path, "value");
    const line = source.split("\n")[(location?.line ?? 1) - 1] ?? "";
    return {
      exact: location?.exact,
      line: location?.line,
      text: line.slice((location?.column ?? 0) - 1, (location?.endColumn ?? 0) - 1),
    };
  };

  test("locates an element field of a multi-line array", () => {
    const source = [
      "[experimental.inspect]",
      "rules = [",
      '  { query = "ok" }, # first',
      "  { query = 123 },",
      "]",
    ].join("\n");
    expect(textAt(source, ["experimental", "inspect", "rules", "1", "query"])).toEqual({
      exact: true,
      line: 4,
      text: "123",
    });
    expect(textAt(source, ["experimental", "inspect", "rules", "0", "query"])).toMatchObject({
      exact: true,
      text: '"ok"',
    });
  });

  test("locates an element field of a single-line array", () => {
    const source = '[experimental.inspect]\nrules = [{ query = "ok" }, { query = 123 }]\n';
    expect(textAt(source, ["experimental", "inspect", "rules", "1", "query"])).toEqual({
      exact: true,
      line: 2,
      text: "123",
    });
  });

  test("locates an element field inside a remote block", () => {
    const source = [
      "[remotes.staging]",
      'project_id = "abcdefghijklmnopqrst"',
      "[remotes.staging.experimental.inspect]",
      'rules = [{ query = "ok" }, { query = 123 }]',
    ].join("\n");
    expect(
      textAt(source, ["remotes", "staging", "experimental", "inspect", "rules", "1", "query"]),
    ).toEqual({ exact: true, line: 4, text: "123" });
  });

  test("falls back to the array key when the element is absent", () => {
    const source = '[experimental.inspect]\nrules = [{ query = "ok" }]\n';
    expect(textAt(source, ["experimental", "inspect", "rules", "3", "query"])).toMatchObject({
      exact: false,
      line: 2,
    });
  });
});
