import { describe, expect, test } from "vitest";
import { scanCliConfigDocument } from "./config-locate.ts";

const locateCliConfigKey = (
  source: string,
  format: "toml" | "json",
  path: ReadonlyArray<string>,
  target: "key" | "value",
) => scanCliConfigDocument(source, format).locate(path, target);
const cliConfigLineKeys = (source: string, format: "toml" | "json") =>
  scanCliConfigDocument(source, format).lineKeys();
const cliConfigValueSpans = (source: string, format: "toml" | "json") =>
  scanCliConfigDocument(source, format).valueSpans();
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

describe("locateCliConfigKey (jsonc)", () => {
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

describe("cliConfigLineKeys", () => {
  test("maps each single-line toml key to its full path, skipping inline tables", () => {
    const keys = cliConfigLineKeys(toml, "toml");
    expect(keys.get(4)).toEqual(["api", "port"]);
    expect(keys.get(5)).toEqual(["api", "tls", "enabled"]);
    expect(keys.get(14)).toEqual(["remotes", "staging", "db", "port"]);
    expect(keys.has(3)).toBe(false);
    expect(keys.has(11)).toBe(false);
  });

  test("leaves out a toml value that spans lines", () => {
    const keys = cliConfigLineKeys(
      '[auth]\nsite_url = "x"\nadditional_redirect_urls = [\n  "a",\n]\n',
      "toml",
    );
    expect(keys.get(2)).toEqual(["auth", "site_url"]);
    expect(keys.has(3)).toBe(false);
  });

  test("maps json lines holding exactly one flat property", () => {
    const source = ["{", '  "api": {', '    "port": 1,', '    "a": 1, "b": 2', "  }", "}"].join(
      "\n",
    );
    const keys = cliConfigLineKeys(source, "json");
    expect(keys.get(3)).toEqual(["api", "port"]);
    expect(keys.has(2)).toBe(false);
    expect(keys.has(4)).toBe(false);
  });

  test("is empty when the text does not parse", () => {
    expect(cliConfigLineKeys("[api\nport = 1", "toml").size).toBe(0);
    expect(cliConfigLineKeys('{ "api": { "port": 1 ', "json").size).toBe(0);
  });
});

describe("cliConfigValueSpans", () => {
  const textOf = (source: string, spans: ReturnType<typeof cliConfigValueSpans>) =>
    (spans ?? []).map((span) => {
      const lines = source.split("\n");
      const first = lines[span.line - 1] ?? "";
      if (span.endLine === undefined || span.endLine === span.line) {
        return first.slice(span.column - 1, (span.endColumn ?? 1) - 1);
      }
      return [
        first.slice(span.column - 1),
        ...lines.slice(span.line, span.endLine - 1),
        (lines[span.endLine - 1] ?? "").slice(0, (span.endColumn ?? 1) - 1),
      ].join("\n");
    });

  test("covers a multi-line toml string and each value of an inline table", () => {
    const source = 'a = """\n# x\nb=="""\nc = { d = 1, e = "two" }\nf = [1, 2]\n';
    expect(textOf(source, cliConfigValueSpans(source, "toml"))).toEqual([
      '"""\n# x\nb=="""',
      "1",
      '"two"',
      "[1, 2]",
    ]);
  });

  test("covers each json scalar, including those of a multi-line array", () => {
    const source = '{\n  "a": [\n    "x",\n    2\n  ],\n  "b": { "c": true }\n}';
    expect(textOf(source, cliConfigValueSpans(source, "json"))).toEqual(['"x"', "2", "true"]);
  });

  test("covers an inline table holding a triple-quoted string as one span", () => {
    const source = 'auth = { jwt_secret = """foo", hunter2 = "x", tail = "bar""" }\n';
    expect(textOf(source, cliConfigValueSpans(source, "toml"))).toEqual([
      '{ jwt_secret = """foo", hunter2 = "x", tail = "bar""" }',
    ]);
  });

  test("is undefined when the text does not parse", () => {
    expect(cliConfigValueSpans('a = """\nx', "toml")).toBeUndefined();
    expect(cliConfigValueSpans('{ "a": ', "json")).toBeUndefined();
  });
});

describe("locateCliConfigKey inline-table keys", () => {
  test("matches a quoted key whose escapes decode to the path segment", () => {
    const source = 'api = { "po\\u0072t" = "bad" }\n';
    const location = locateCliConfigKey(source, "toml", ["api", "port"], "value");

    expect(location?.exact).toBe(true);
    expect(source.slice((location?.column ?? 0) - 1, (location?.endColumn ?? 0) - 1)).toBe('"bad"');
  });
});
