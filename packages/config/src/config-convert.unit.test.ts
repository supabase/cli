import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import * as SmolToml from "smol-toml";
import {
  CliConfigConvertError,
  convertCliConfigTomlToJsonc,
  type MovedTomlComment,
} from "./config-convert.ts";
import { loadCliConfig, parseCliConfigDocumentFile } from "./io.ts";
import { parseJsonc } from "./jsonc.ts";
import { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";

function converted(source: string) {
  return Effect.runSync(convertCliConfigTomlToJsonc(source));
}

function refusal(source: string): CliConfigConvertError {
  return Effect.runSync(Effect.flip(convertCliConfigTomlToJsonc(source)));
}

function uncommented(text: string): unknown {
  return parseJsonc(text.replace(/^(\s*)\/\/ (?=\s*["{}[\]])/gm, "$1"));
}

function body(source: string): string {
  const { text } = converted(source);
  return text.split("\n").slice(2, -2).join("\n").replace(/^\n+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaves(value: unknown, path: ReadonlyArray<string> = []): Map<string, string> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return new Map([[path.join("."), JSON.stringify(value)]]);
  }
  return new Map(
    Object.entries(value).flatMap(([key, child]) => [...leaves(child, [...path, key])]),
  );
}

function changed(after: Map<string, string>, before: Map<string, string>) {
  return new Map([...after].filter(([path, value]) => before.get(path) !== value));
}

const EXAMPLE_LINE = /^# (\[\[?[^\]]+\]\]?|[\w."'-]+ = .+)$/;

function commentedMembers(lines: ReadonlyArray<string>): Array<readonly [number, number]> {
  const members: Array<readonly [number, number]> = [];
  for (let start = 0; start < lines.length; start++) {
    const match = /^(\s*)\/\/ "[^"]+": (.*)$/.exec(lines[start] ?? "");
    if (match === null) {
      continue;
    }
    let end = start;
    if (/[{[],?$/.test(match[2] ?? "") && !/[}\]],?$/.test(match[2] ?? "")) {
      const close = new RegExp(`^${match[1]}// [}\\]],?$`);
      while (end < lines.length && !close.test(lines[end] ?? "")) {
        end++;
      }
      if (end === lines.length) {
        throw new Error(`No closing delimiter for the commented member on line ${start + 1}`);
      }
    }
    members.push([start, end]);
    start = end;
  }
  return members;
}

function expectExamplesUncommentAtTomlPaths(source: string) {
  const lines = converted(source).text.split("\n");
  const active = leaves(parseJsonc(lines.join("\n")));
  const withExamples = source
    .split("\n")
    .map((line) => (EXAMPLE_LINE.test(line) ? line.slice(2) : line))
    .join("\n");
  const expected = changed(leaves(SmolToml.parse(withExamples)), leaves(SmolToml.parse(source)));
  const members = commentedMembers(lines);
  const seen = new Map<string, string>();
  for (const [start, end] of members) {
    const document = lines
      .map((line, index) =>
        index >= start && index <= end ? line.replace(/^(\s*)\/\/ ?/, "$1") : line,
      )
      .join("\n");
    const gained = changed(leaves(parseJsonc(document)), active);
    expect(gained.size).toBeGreaterThan(0);
    for (const [path, value] of gained) {
      seen.set(path, value);
    }
  }
  expect(members.length).toBeGreaterThan(0);
  expect(seen).toEqual(expected);
}

function expectEachCommentOnce(source: string, text: string) {
  const emitted = text.split("\n").map((line) => line.trim().replace(/^(\/\/\s*)+/, ""));
  const prose = source
    .split("\n")
    .filter((line) => line.startsWith("# ") && !EXAMPLE_LINE.test(line))
    .map((line) => line.slice(2).trimEnd());
  for (const comment of new Set(prose)) {
    expect(
      emitted.filter((line) => line === comment),
      comment,
    ).toHaveLength(prose.filter((line) => line === comment).length);
  }
}

describe("convertCliConfigTomlToJsonc: schema", () => {
  test("promotes the #:schema directive to $schema without repeating it as a comment", () => {
    const outcome = converted('#:schema https://example.com/s.json\nproject_id = "demo"\n');
    expect(outcome.schemaRef).toBe("https://example.com/s.json");
    expect(outcome.schemaSource).toBe("directive");
    expect(outcome.commentCount).toBe(0);
    expect(outcome.text).toBe(
      '{\n  "$schema": "https://example.com/s.json",\n  "project_id": "demo"\n}\n',
    );
  });

  test("falls back to the current schema URL without a directive", () => {
    const outcome = converted('project_id = "demo"\n');
    expect(outcome.schemaRef).toBe(CLI_CONFIG_SCHEMA_URL);
    expect(outcome.schemaSource).toBe("default");
  });

  test("refuses a #:schema directive and a different $schema key", () => {
    const error = refusal(
      '#:schema https://example.com/a.json\nproject_id = "demo"\n"$schema" = "https://example.com/b.json"\n',
    );
    expect(error.reason).toBe("unsupported_value");
    expect(error.detail).toContain("#:schema https://example.com/a.json");
  });

  test("keeps a $schema key that repeats the directive, without repeating the directive", () => {
    const outcome = converted(
      '#:schema https://example.com/a.json\nproject_id = "demo"\n"$schema" = "https://example.com/a.json"\n',
    );
    expect(outcome.schemaSource).toBe("key");
    expect(outcome.text).toBe(
      '{\n  "$schema": "https://example.com/a.json",\n  "project_id": "demo"\n}\n',
    );
  });

  test("reads a #:schema directive below leading comments, as the loader does", () => {
    const outcome = converted(
      '# Project settings.\n\n  #:schema https://example.com/s.json\n# More notes.\nproject_id = "demo"\n',
    );
    expect(outcome.schemaRef).toBe("https://example.com/s.json");
    expect(outcome.schemaSource).toBe("directive");
    expect(outcome.text).not.toContain("#:schema");
    expect(outcome.text).not.toContain("//:schema");
    expect(outcome.text).toContain("// Project settings.");
    expect(outcome.text).toContain("// More notes.");
  });

  test("reads a #:schema directive that has trailing whitespace", () => {
    const outcome = converted('#:schema https://example.com/s.json  \nproject_id = "demo"\n');
    expect(outcome.schemaRef).toBe("https://example.com/s.json");
    expect(outcome.schemaSource).toBe("directive");
    expect(outcome.commentCount).toBe(0);
  });

  test("ignores a #:schema line that is not the first line", () => {
    const outcome = converted('project_id = "demo"\n#:schema https://example.com/a.json\n');
    expect(outcome.schemaSource).toBe("default");
    expect(outcome.text).toContain("//:schema https://example.com/a.json");
  });
});

describe("convertCliConfigTomlToJsonc: values", () => {
  test("keeps env() references byte-identical", () => {
    expect(body('[auth.external.github]\nsecret = "env(GITHUB_SECRET)"\n')).toBe(
      [
        '  "auth": {',
        '    "external": {',
        '      "github": {',
        '        "secret": "env(GITHUB_SECRET)"',
        "      }",
        "    }",
        "  }",
      ].join("\n"),
    );
  });

  test("keeps a comment starting with a quoted string with invalid escapes as prose", () => {
    const source = '# "C:\\Users\\me" holds it\n# ["\\xZZ"]\n# "\\uZZZZ" = 1\na = 1\n';
    const { text } = converted(source);
    expect(text).toContain('// "C:\\Users\\me" holds it');
    expect(text).toContain('// ["\\xZZ"]');
    expect(parseJsonc(text)).toEqual({ $schema: CLI_CONFIG_SCHEMA_URL, a: 1 });
  });

  test("decodes hexadecimal and escape-character escapes in quoted keys", () => {
    const { text } = converted('[functions."\\x61"]\nk = 1\n"\\e" = 2\n');
    expect(parseJsonc(text)).toEqual({
      $schema: CLI_CONFIG_SCHEMA_URL,
      functions: { a: { k: 1, "\u001b": 2 } },
    });
  });

  test("expands dotted keys, implicit parents, and parents declared after their children", () => {
    const source = '[a.b]\nx = 1\n[c]\ny = true\n[a]\nz.w = "s"\n';
    expect(JSON.parse(converted(source).text)).toEqual({
      $schema: CLI_CONFIG_SCHEMA_URL,
      a: { b: { x: 1 }, z: { w: "s" } },
      c: { y: true },
    });
    expect(body(source).indexOf('"a"')).toBeLessThan(body(source).indexOf('"c"'));
  });

  test("renders inline tables expanded and empty containers compactly", () => {
    expect(body("t = { a = 1, b = [] }\ne = {}\n")).toBe(
      ['  "t": {', '    "a": 1,', '    "b": []', "  },", '  "e": {}'].join("\n"),
    );
  });

  test("keeps a one-line array on one line and spreads a multi-line array", () => {
    expect(body('a = ["x", "y"]\nb = [\n  "x",\n  "y",\n]\n')).toBe(
      ['  "a": ["x", "y"],', '  "b": [', '    "x",', '    "y"', "  ]"].join("\n"),
    );
  });

  test("renders array-of-tables elements as objects with their own comments", () => {
    const source =
      '[[experimental.inspect.rules]]\n# first\nname = "a"\n\n# second element\n[[experimental.inspect.rules]]\nname = "b" # why b\n';
    expect(body(source)).toBe(
      [
        '  "experimental": {',
        '    "inspect": {',
        '      "rules": [',
        "        {",
        "          // first",
        '          "name": "a"',
        "        },",
        "",
        "        // second element",
        "        {",
        '          "name": "b" // why b',
        "        }",
        "      ]",
        "    }",
        "  }",
      ].join("\n"),
    );
  });

  test("writes CRLF output for a CRLF source", () => {
    const { text } = converted('# c\r\nproject_id = "demo"\r\n');
    expect(text).toBe(
      `{\r\n  "$schema": "${CLI_CONFIG_SCHEMA_URL}",\r\n\r\n  // c\r\n  "project_id": "demo"\r\n}\r\n`,
    );
  });

  test("strips a leading byte order mark", () => {
    expect(converted('﻿#:schema https://example.com/s.json\nproject_id = "d"\n').schemaRef).toBe(
      "https://example.com/s.json",
    );
  });
});

describe("convertCliConfigTomlToJsonc: comments", () => {
  test("a group directly above a key or header leads it", () => {
    expect(body('# about id\nproject_id = "demo"\n# about api\n[api]\nport = 1\n')).toBe(
      [
        "  // about id",
        '  "project_id": "demo",',
        "  // about api",
        '  "api": {',
        '    "port": 1',
        "  }",
      ].join("\n"),
    );
  });

  test("same-line comments follow the comma on keys and sit after the brace on headers", () => {
    expect(body('[api] # the api\nport = 1 # the port\nschemas = ["a"] # many\n')).toBe(
      [
        '  "api": { // the api',
        '    "port": 1, // the port',
        '    "schemas": ["a"] // many',
        "  }",
      ].join("\n"),
    );
  });

  test("a group below a key stays with it, before the next child table", () => {
    expect(body("[api]\nport = 1\n# about tls\n\n[api.tls]\nenabled = false\n")).toBe(
      [
        '  "api": {',
        '    "port": 1,',
        "    // about tls",
        "",
        '    "tls": {',
        '      "enabled": false',
        "    }",
        "  }",
      ].join("\n"),
    );
  });

  test("a detached group leads the next member and keeps its blank lines", () => {
    expect(body("a = 1\n\n# about b\n\nb = 2\n")).toBe(
      ['  "a": 1,', "", "  // about b", "", '  "b": 2'].join("\n"),
    );
  });

  test("a table with only commented keys keeps them inside its braces", () => {
    expect(body('[db.vault]\n# secret = "env(X)"\n\n[db.pooler]\nenabled = true\n')).toBe(
      [
        '  "db": {',
        '    "vault": {',
        '      // "secret": "env(X)",',
        "    },",
        "",
        '    "pooler": {',
        '      "enabled": true',
        "    }",
        "  }",
      ].join("\n"),
    );
  });

  test("a detached top-of-file group sits above the opening brace", () => {
    const { text } = converted('# file header\n\nproject_id = "demo"\n');
    expect(text.startsWith("// file header\n\n{\n")).toBe(true);
  });

  test("a detached end-of-file group closes the root object", () => {
    const { text } = converted("a = 1\n\n# the end\n");
    expect(text).toBe(`{\n  "$schema": "${CLI_CONFIG_SCHEMA_URL}",\n  "a": 1\n\n  // the end\n}\n`);
  });

  test("keeps the text after the hash verbatim and trims trailing whitespace", () => {
    expect(body("#tight\n#  wide   \na = 1\n")).toBe(
      ["  //tight", "  //  wide", '  "a": 1'].join("\n"),
    );
  });

  test("keeps comments inside a multi-line scalar array next to their elements", () => {
    const source =
      'x = 1\n[api]\nschemas = [\n  # about a\n  "a", # keep a\n  "b",\n  # after b\n]\n';
    const outcome = converted(source);
    expect(body(source)).toContain(
      [
        '    "schemas": [',
        "      // about a",
        '      "a", // keep a',
        '      "b"',
        "      // after b",
        "    ]",
      ].join("\n"),
    );
    expect(outcome.commentCount).toBe(3);
    expect(outcome.movedComments).toEqual([]);
  });

  test("keeps a comment after the opening bracket as the first element's lead", () => {
    expect(body("a = [ # note\n  1,\n  2,\n]\n")).toBe(
      ['  "a": [', "    // note", "    1,", "    2", "  ]"].join("\n"),
    );
  });

  test("hoists comments inside nested arrays above their key and reports them", () => {
    const source = "x = 1\n[api]\nm = [\n  [1, 2], # keep\n  [3],\n]\n";
    const outcome = converted(source);
    expect(body(source)).toContain(["    // keep", '    "m": ['].join("\n"));
    expect(outcome.commentCount).toBe(1);
    expect(outcome.movedComments).toEqual([
      { line: 4, text: "# keep", anchor: ["api", "m"] },
    ] satisfies ReadonlyArray<MovedTomlComment>);
  });

  test("hoists comments inside an inline table, including ones that hold a brace", () => {
    const source = "a = { b = [\n 1, # why }\n] }\n";
    const outcome = converted(source);
    expect(body(source)).toBe(["  // why }", '  "a": {', '    "b": [1]', "  }"].join("\n"));
    expect(outcome.movedComments).toEqual([
      { line: 2, text: "# why }", anchor: ["a"] },
    ] satisfies ReadonlyArray<MovedTomlComment>);
  });

  test("keeps comments of a multi-line inline table", () => {
    const outcome = converted("t = {\n  a = 1, # c\n  b = 2,\n}\n");
    expect(outcome.text).toContain("// c");
    expect(outcome.movedComments).toEqual([
      { line: 2, text: "# c", anchor: ["t"] },
    ] satisfies ReadonlyArray<MovedTomlComment>);
  });

  test("a comment above a table declared after its subtables stays before that header's keys", () => {
    const source = "[auth.email]\nx = 1\n\n# about auth\n[auth]\ny = 2\n";
    const outcome = converted(source);
    expect(body(source)).toBe(
      [
        '  "auth": {',
        '    "email": {',
        '      "x": 1',
        "    },",
        "",
        "    // about auth",
        '    "y": 2',
        "  }",
      ].join("\n"),
    );
    expect(outcome.movedComments).toEqual([]);
  });

  test("keeps the blank line before an implicit parent table", () => {
    expect(body('a = 1\n\n[remotes.staging]\nproject_id = "x"\n')).toBe(
      [
        '  "a": 1,',
        "",
        '  "remotes": {',
        '    "staging": {',
        '      "project_id": "x"',
        "    }",
        "  }",
      ].join("\n"),
    );
  });
});

describe("convertCliConfigTomlToJsonc: commented-out examples", () => {
  test("a commented key becomes a commented member in place and ends the last real member with a comma", () => {
    const source = "[api]\n# Port to use.\n# port = 1\nenabled = true\n# max_rows = 5\n";
    const outcome = converted(source);
    expect(body(source)).toBe(
      [
        '  "api": {',
        "    // Port to use.",
        '    // "port": 1,',
        '    "enabled": true,',
        '    // "max_rows": 5,',
        "  }",
      ].join("\n"),
    );
    expectEachCommentOnce(source, outcome.text);
    expect(uncommented(outcome.text)).toEqual({
      $schema: CLI_CONFIG_SCHEMA_URL,
      api: { port: 1, enabled: true, max_rows: 5 },
    });
  });

  test("a dotted commented key joins the existing table on its path", () => {
    const source =
      "[auth]\nhook.send_sms.enabled = true\n# hook.custom_access_token.enabled = true\n";
    const { text } = converted(source);
    const uncommented = text.replace('// "custom_access_token"', '"custom_access_token"');
    expect(parseJsonc(uncommented)).toMatchObject({
      auth: { hook: { send_sms: { enabled: true }, custom_access_token: { enabled: true } } },
    });
    expectExamplesUncommentAtTomlPaths(source);
  });

  test("a dotted commented key under a table declared by header joins it", () => {
    const source =
      "[auth]\nenabled = true\n# Use a custom hook.\n# hook.b.enabled = true\n\n[auth.hook.a]\nenabled = true\n";
    const { text } = converted(source);
    expect(text).toContain(
      ["      // Use a custom hook.", '      // "b": { "enabled": true },'].join("\n"),
    );
    expectExamplesUncommentAtTomlPaths(source);
    expectEachCommentOnce(source, text);
  });

  test("commented dotted keys sharing a parent become one commented object", () => {
    const source =
      '[auth]\nenabled = true\n# [auth.hook]\n# send_sms.enabled = true\n# send_sms.uri = "pg-functions://x"\n';
    const { text } = converted(source);
    expect(text.match(/"send_sms"/g)).toHaveLength(1);
    expect(uncommented(text)).toMatchObject({
      auth: { hook: { send_sms: { enabled: true, uri: "pg-functions://x" } } },
    });
    expectEachCommentOnce(source, text);
  });

  test("commented dotted keys in an active table share one commented object", () => {
    const source = '[auth]\nenabled = true\n# hook.a.enabled = true\n# hook.a.uri = "x"\n';
    const { text } = converted(source);
    expect(text.match(/"hook"/g)).toHaveLength(1);
    expect(uncommented(text)).toMatchObject({
      auth: { enabled: true, hook: { a: { enabled: true, uri: "x" } } },
    });
  });

  test("prose above a grouped commented dotted key stays directly above that key", () => {
    const sources = [
      '[auth]\nenabled = true\n# hook.a.enabled = true\n# URI to invoke\n# hook.a.uri = "x"\n',
      '[auth]\n# hook.a.enabled = true\nenabled = true\n# URI to invoke\n# hook.a.uri = "x"\n',
    ];
    for (const source of sources) {
      const lines = converted(source).text.split("\n");
      const prose = lines.findIndex((line) => line.includes("// URI to invoke"));
      expect(lines[prose + 1]).toMatch(/^\s*\/\/\s+"uri": "x"/);
      expectEachCommentOnce(source, converted(source).text);
    }
  });

  test("commented dotted keys separated by blank lines share one commented object", () => {
    const source = '[auth]\nenabled = true\n# hook.a.enabled = true\n\n# hook.a.uri = "x"\n';
    const { text } = converted(source);
    expect(text.match(/"hook"/g)).toHaveLength(1);
    expect(uncommented(text)).toMatchObject({
      auth: { enabled: true, hook: { a: { enabled: true, uri: "x" } } },
    });
    expectEachCommentOnce(source, text);
  });

  test("a prose paragraph between parts of a commented table keeps the table open", () => {
    const sources = [
      '[api]\nport = 1\n\n# [api.tls]\n# enabled = true\n\n# Paths below are relative.\n\n# cert = "c"\n',
      '[api]\nport = 1\n\n# [storage.s3]\n# enabled = true\n\n# Credentials:\n\n# key = "k"\n\n[db]\nx = 1\n',
    ];
    const expected = [
      { api: { port: 1, tls: { enabled: true, cert: "c" } } },
      { api: { port: 1 }, storage: { s3: { enabled: true, key: "k" } }, db: { x: 1 } },
    ];
    for (const [index, source] of sources.entries()) {
      const { text } = converted(source);
      expect(uncommented(text)).toStrictEqual({
        $schema: CLI_CONFIG_SCHEMA_URL,
        ...expected[index],
      });
      expectEachCommentOnce(source, text);
    }
  });

  test("a detached prose paragraph stays above the commented example that follows it", () => {
    const sources = [
      '[auth]\nenabled = true\n\n# Uncomment to customise SMTP:\n\n# [auth.smtp]\n# host = "x"\n\n[db]\nport = 1\n',
      '[auth]\nenabled = true\n\n# Uncomment to set the URL:\n\n# site_url = "x"\n',
    ];
    for (const source of sources) {
      const lines = converted(source).text.split("\n");
      const prose = lines.findIndex((line) => line.includes("// Uncomment to"));
      expect(lines[prose + 1]).toMatch(/^\s+\/\/ "(smtp|site_url)"/);
      expect(lines.slice(prose).findIndex((line) => line.startsWith("  }"))).toBeGreaterThan(1);
      expectEachCommentOnce(source, converted(source).text);
    }
  });

  test("a detached prose paragraph before an active table still leads that table", () => {
    const source =
      "[api]\nport = 1\n\n# [api.tls]\n# enabled = true\n\n# Database settings.\n\n[db]\nx = 1\n";
    const lines = converted(source).text.split("\n");
    const prose = lines.findIndex((line) => line.includes("// Database settings."));
    expect(lines.slice(prose + 1).find((line) => line.trim() !== "")).toMatch(/^\s+"db": \{/);
  });

  test("commented dotted keys separated by an active key share one commented object", () => {
    const source = '[auth]\n# hook.a.enabled = true\nenabled = true\n# hook.a.uri = "x"\n';
    const { text } = converted(source);
    expect(text.match(/"hook"/g)).toHaveLength(1);
    expect(uncommented(text)).toMatchObject({
      auth: { enabled: true, hook: { a: { enabled: true, uri: "x" } } },
    });
  });

  test("a commented dotted key joins a commented table example on the same path", () => {
    const before =
      '[auth]\nenabled = true\n# hook.a.uri = "x"\n\n# [auth.hook.a]\n# enabled = true\n';
    const after = '[auth]\n# [auth.hook.a]\n# enabled = true\nenabled = true\n# hook.a.uri = "x"\n';
    for (const source of [before, after]) {
      const { text } = converted(source);
      expect(text.match(/"hook"/g)).toHaveLength(1);
      expect(uncommented(text)).toMatchObject({
        auth: { enabled: true, hook: { a: { enabled: true, uri: "x" } } },
      });
      expectEachCommentOnce(source, text);
    }
  });

  test("a blank line inside a commented table example keeps the later keys in that example", () => {
    const source = '[auth]\nenabled = true\n# [auth.hook.a]\n# enabled = true\n\n# uri = "x"\n';
    const { text } = converted(source);
    const parsed = uncommented(text);
    expect(parsed).toMatchObject({
      auth: { enabled: true, hook: { a: { enabled: true, uri: "x" } } },
    });
    expect(parsed).not.toHaveProperty("auth.uri");
    expectEachCommentOnce(source, text);
  });

  test("a dotted commented key becomes a nested inline object", () => {
    const source = "[auth]\nenabled = true\n# hook.send_sms.enabled = true\n";
    expect(body(source)).toContain('    // "hook": { "send_sms": { "enabled": true } },');
    expect(uncommented(converted(source).text)).toMatchObject({
      auth: { hook: { send_sms: { enabled: true } } },
    });
  });

  test("a commented header whose table exists puts its keys inside that table", () => {
    const source =
      '[db]\nport = 1\n\n[db.vault]\nenabled = true\n\n[db.pooler]\nport = 2\n\n# [db.vault]\n# secret_key = "env(X)"\n';
    const outcome = converted(source);
    expect(body(source)).toContain(
      ['      "enabled": true,', "", '      // "secret_key": "env(X)",', "    },"].join("\n"),
    );
    expect(uncommented(outcome.text)).toMatchObject({
      db: { vault: { enabled: true, secret_key: "env(X)" } },
    });
  });

  test("a commented header under a missing parent lands in the nearest existing ancestor", () => {
    const source =
      '[auth]\nenabled = true\n\n# [auth.hook.custom_access_token]\n# enabled = true\n# uri = "pg-functions://x"\n\n[auth.sms]\nenabled = false\n';
    const outcome = converted(source);
    expect(body(source)).toBe(
      [
        '  "auth": {',
        '    "enabled": true,',
        "",
        '    // "hook": {',
        '    //   "custom_access_token": {',
        '    //     "enabled": true,',
        '    //     "uri": "pg-functions://x"',
        "    //   }",
        "    // },",
        "",
        '    "sms": {',
        '      "enabled": false',
        "    }",
        "  }",
      ].join("\n"),
    );
    expect(uncommented(outcome.text)).toMatchObject({
      auth: { hook: { custom_access_token: { enabled: true, uri: "pg-functions://x" } } },
    });
  });

  test("a block closed before the end of its ancestor goes to the end of the ancestor", () => {
    const source =
      "[auth]\nenabled = true\n\n[auth.sms]\nenabled = false\n\n# [auth.captcha]\n# enabled = true\n\n[studio]\nenabled = true\n";
    expect(body(source)).toContain(
      ["    },", "", '    // "captcha": {', '    //   "enabled": true', "    // },", "  },"].join(
        "\n",
      ),
    );
  });

  test("blocks under the same missing parent merge into one commented object", () => {
    const source =
      "[auth]\nenabled = true\n\n# This hook runs first.\n# [auth.hook.before_user_created]\n# enabled = true\n\n# This hook runs second.\n# [auth.hook.custom_access_token]\n# enabled = false\n";
    const outcome = converted(source);
    expect(body(source)).toBe(
      [
        '  "auth": {',
        '    "enabled": true,',
        "",
        "    // This hook runs first.",
        '    // "hook": {',
        '    //   "before_user_created": {',
        '    //     "enabled": true',
        "    //   },",
        "    //   // This hook runs second.",
        '    //   "custom_access_token": {',
        '    //     "enabled": false',
        "    //   }",
        "    // },",
        "  }",
      ].join("\n"),
    );
    expect(uncommented(outcome.text)).toMatchObject({
      auth: {
        hook: { before_user_created: { enabled: true }, custom_access_token: { enabled: false } },
      },
    });
  });

  test("prose directly above a commented header moves with its block", () => {
    const source =
      '[auth]\nenabled = true\n\n# Configure sessions.\n# [auth.sessions]\n# Force log out.\n# timebox = "24h"\n\n[studio]\nenabled = true\n';
    expect(body(source)).toContain(
      [
        "    // Configure sessions.",
        '    // "sessions": {',
        "    //   // Force log out.",
        '    //   "timebox": "24h"',
        "    // },",
      ].join("\n"),
    );
    expectEachCommentOnce(source, converted(source).text);
  });

  test("a commented header with no keys becomes an empty commented object", () => {
    const source = "[storage]\nenabled = true\n# [storage.buckets.my-bucket]\n";
    expect(uncommented(converted(source).text)).toMatchObject({
      storage: { buckets: { "my-bucket": {} } },
    });
  });

  test("a commented array-of-tables header becomes a commented array", () => {
    const source =
      '[experimental]\nenabled = true\n# [[experimental.rules]]\n# name = "a"\n# [[experimental.rules]]\n# name = "b"\n';
    expect(body(source)).toContain(
      [
        '    // "rules": [',
        "    //   {",
        '    //     "name": "a"',
        "    //   },",
        "    //   {",
        '    //     "name": "b"',
        "    //   }",
        "    // ],",
      ].join("\n"),
    );
    expect(uncommented(converted(source).text)).toMatchObject({
      experimental: { rules: [{ name: "a" }, { name: "b" }] },
    });
  });

  test("prose and lines that only look like TOML stay verbatim comments", () => {
    const source = [
      "[api]",
      "enabled = true",
      "# Set port = 1 to change it.",
      "# port = ",
      "# mode = maybe",
      "# list = [1, 2",
      "# when = 1979-05-27",
      "# [api tls]",
      "# size = 1 # note",
      "",
    ].join("\n");
    const outcome = converted(source);
    expect(body(source)).toBe(
      [
        '  "api": {',
        '    "enabled": true',
        "    // Set port = 1 to change it.",
        "    // port =",
        "    // mode = maybe",
        "    // list = [1, 2",
        "    // when = 1979-05-27",
        "    // [api tls]",
        "    // size = 1 # note",
        "  }",
      ].join("\n"),
    );
    expectEachCommentOnce(source, outcome.text);
  });

  test("a commented header that collides with a real key stays verbatim", () => {
    const source = "[api]\nport = 1\n\n# [api.port.extra]\n# a = 1\n\n[studio]\nenabled = true\n";
    expect(converted(source).text).toContain("// [api.port.extra]\n    // a = 1");
  });

  test("a commented key above a nested table header stays in the object it follows", () => {
    const source = "[a]\nx = 1\n\n# y = 2\n[a.b.c]\nz = 3\n";
    expect(uncommented(converted(source).text)).toMatchObject({
      a: { x: 1, y: 2, b: { c: { z: 3 } } },
    });
  });

  test.each([
    ["a sibling header", "[api]\nenabled = true\n# max_rows = 1000\n[db]\nport = 1\n"],
    [
      "a later reopening of an outer table",
      "[api]\nenabled = true\n[db]\nport = 1\n# max = 1\n[api.tls]\nx = 1\n",
    ],
    [
      "the next array-of-tables element",
      '[[experimental.inspect.rules]]\nname = "a"\n# query = "select 1"\n[[experimental.inspect.rules]]\nname = "b"\n',
    ],
    [
      "a blank line before a sibling header",
      "[api]\nenabled = true\n\n# max_rows = 1000\n\n[db]\nport = 1\n",
    ],
    ["a dotted key", "[auth]\nhook.x = 1\n# y = 2\n[db]\nport = 1\n"],
    ["a key detached at the top of the file", '# Main\n# project_id = "x"\n\n[api]\nport = 1\n'],
    ["a file holding only a commented key", "# b = 2\n"],
    [
      "prose, a key and a header in one group",
      "[api]\nenabled = true\n# max_rows = 1000\n# About db.\n[db]\nport = 1\n",
    ],
    [
      "a second commented array element with its own prose",
      "[a]\nz = 1\n# [[a.rules]]\n# name = 'a'\n# Second.\n# [[a.rules]]\n# name = 'b'\n",
    ],
  ])("a commented key above %s uncomments at its TOML path", (_name, source) => {
    expectExamplesUncommentAtTomlPaths(source);
    expectEachCommentOnce(source, converted(source).text);
  });

  test("prose above a second commented array element stays inside the array", () => {
    const source =
      "[a]\nz = 1\n# [[a.rules]]\n# name = 'a'\n# Second.\n# [[a.rules]]\n# name = 'b'\n";
    expect(body(source)).toContain(["    //   },", "    //   // Second.", "    //   {"].join("\n"));
  });

  test("a commented header naming an existing table without keys stays verbatim", () => {
    const source = "[db.vault]\nenabled = true\n\n[api]\nport = 1\n\n# [db.vault]\n";
    const { text } = converted(source);
    expect(text).toContain("// [db.vault]");
    expect(parseJsonc(text)).toMatchObject({ db: { vault: { enabled: true } }, api: { port: 1 } });
  });

  test("a commented table header with prose but no keys stays verbatim", () => {
    const source = "[db]\nenabled = true\n\n# [db]\n# Some prose\n\n[api]\nport = 1\n";
    const { text } = converted(source);
    expect(text).toContain("// [db]");
    expect(text).toContain("// Some prose");
    expectEachCommentOnce(source, text);
  });

  test("trailing prose after the last commented block stays inside that block", () => {
    const source =
      "[auth]\nenabled = true\n\n# [auth.hook.a]\n# enabled = true\n# Trailing prose.\n\n[studio]\nx = 1\n";
    expect(body(source)).toContain(
      ['    //     "enabled": true', "    //     // Trailing prose.", "    //   }"].join("\n"),
    );
  });

  test("prose directly above the next table after a commented block leads that table", () => {
    const source =
      "[auth]\nenabled = true\n# [auth.hook.a]\n# enabled = true\n# Studio settings.\n[studio]\nx = 1\n";
    const { text } = converted(source);
    expect(text).toContain(["  // Studio settings.", '  "studio": {'].join("\n"));
    expectEachCommentOnce(source, text);
  });

  test("a verbatim fallback keeps its source order relative to merged blocks", () => {
    const source = "[a]\nz = 1\n# [[a.r]]\n# n = 1\n# [a.r]\n# n = 2\n";
    const { text } = converted(source);
    expect(text.indexOf('"r": [')).toBeLessThan(text.indexOf("// [a.r]"));
    expectEachCommentOnce(source, text);
  });

  test.each([
    [
      "a dotted key with spaced dots",
      "[db]\nport = 1\n# e.g. port = 5432\n",
      "// e.g. port = 5432",
    ],
    ["a bracketed word", "[db]\nport = 1\n# [Deprecated]\n# [note]\n", "// [Deprecated]"],
  ])("prose that looks like TOML stays a comment: %s", (_name, source, line) => {
    const { text } = converted(source);
    expect(text).toContain(line);
    expect(parseJsonc(text)).toEqual({ $schema: CLI_CONFIG_SCHEMA_URL, db: { port: 1 } });
    expect(commentedMembers(text.split("\n"))).toEqual([]);
  });
});

describe("convertCliConfigTomlToJsonc: refusals", () => {
  test("refuses TOML dates with the line and how to fix them", () => {
    const error = refusal("a = 1\nwhen = 1979-05-27\n");
    expect(error).toBeInstanceOf(CliConfigConvertError);
    expect(error).toMatchObject({ reason: "unsupported_value", sourceLine: 2 });
    expect(error.detail).toContain("Quote the value as a string, then rerun");
  });

  test("refuses non-finite floats", () => {
    expect(refusal("a = inf\n").reason).toBe("unsupported_value");
    expect(refusal("a = nan\n").reason).toBe("unsupported_value");
  });

  test("refuses malformed TOML with the line", () => {
    expect(refusal("a = 1\nb = \n")).toMatchObject({ reason: "parse_error", sourceLine: 2 });
  });

  test("leaves the source line undefined when the refusal has none", () => {
    expect(refusal('"$schema" = 1\n').sourceLine).toBeUndefined();
  });
});

const RICH_TOML = `#:schema ${CLI_CONFIG_SCHEMA_URL}

# project
project_id = "demo"

[api]
port = 54321 # api port
schemas = [
  "public", # exposed
  "graphql_public",
]

[auth.external.github]
enabled = true
client_id = "env(GITHUB_ID)"
secret = "env(GITHUB_SECRET)"

[functions.hello]
verify_jwt = false
entrypoint = "./functions/hello/index.ts"

[[experimental.inspect.rules]]
name = "a"
query = "select 1"

[[experimental.inspect.rules]]
name = "b"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.api]
port = 1
`;

describe("convertCliConfigTomlToJsonc: loader round trip", () => {
  test("a converted project loads to the same config and raw document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = "GITHUB_ID=id\nGITHUB_SECRET=shh\n";
      const makeProject = Effect.fnUntraced(function* (file: string, content: string) {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-convert-" });
        yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "supabase", file), content);
        yield* fs.writeFileString(path.join(root, ".env"), env);
        return root;
      });

      const tomlRoot = yield* makeProject("config.toml", RICH_TOML);
      const jsoncRoot = yield* makeProject("config.jsonc", converted(RICH_TOML).text);

      const fromToml = yield* loadCliConfig(tomlRoot, { search: false });
      const fromJsonc = yield* loadCliConfig(jsoncRoot, { search: false });
      const rawToml = yield* parseCliConfigDocumentFile(tomlRoot, { search: false });
      const rawJsonc = yield* parseCliConfigDocumentFile(jsoncRoot, { search: false });

      expect(fromJsonc?.format).toBe("json");
      expect(fromJsonc?.config).toEqual(fromToml?.config);
      expect(fromJsonc?.config.remotes["staging"]?.project_id).toBe("abcdefghijklmnopqrst");
      expect(fromJsonc?.config.functions["hello"]?.verify_jwt).toBe(false);
      expect(fromJsonc?.config.experimental["inspect"]?.rules).toHaveLength(2);
      const { $schema: _schema, ...jsoncDocument } = Object(rawJsonc?.rawDocument);
      expect(jsoncDocument).toEqual(rawToml?.rawDocument);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
});
