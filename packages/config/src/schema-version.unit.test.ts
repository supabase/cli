import { describe, expect, test } from "vitest";
import type { ConfigFormat } from "./config-format.ts";
import { readCliConfigSchemaDeclaration } from "./schema-version.ts";

const versioned = (n: string) => `https://supabase.com/schemas/config/v${n}.json`;

describe("readCliConfigSchemaDeclaration", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly format: ConfigFormat;
    readonly document?: unknown;
    readonly expected: { readonly ref: string; readonly version: bigint | undefined } | undefined;
  }> = [
    {
      name: "reads $schema from a JSON document",
      text: "",
      format: "json",
      document: { $schema: versioned("2") },
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "ignores a TOML-style directive in a JSON file",
      text: `#:schema ${versioned("2")}\n`,
      format: "json",
      document: {},
      expected: undefined,
    },
    {
      name: "reads a leading TOML directive before the document is parsed",
      text: `#:schema ${versioned("3")}\n[db]\n`,
      format: "toml",
      document: undefined,
      expected: { ref: versioned("3"), version: 3n },
    },
    {
      name: "allows a BOM, blank lines and comments before the directive",
      text: `﻿\n# a comment\n\r\n#:schema ${versioned("2")}\r\n[db]\r\n`,
      format: "toml",
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "reads a directive with trailing spaces",
      text: `#:schema ${versioned("2")}  \n[db]\n`,
      format: "toml",
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "reads a directive with a trailing tab and CRLF",
      text: `#:schema ${versioned("2")}\t\r\n[db]\r\n`,
      format: "toml",
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "reads an indented directive",
      text: `  \t#:schema ${versioned("2")}\n[db]\n`,
      format: "toml",
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "reads a directive after an indented ordinary comment",
      text: `  # note\n#:schema ${versioned("2")}\n[db]\n`,
      format: "toml",
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "ignores an indented table header before a directive",
      text: `  [db]\n#:schema ${versioned("2")}\n`,
      format: "toml",
      document: { db: {} },
      expected: undefined,
    },
    {
      name: "ignores a directive that follows a non-comment line",
      text: `project_id = "x"\n#:schema ${versioned("2")}\n`,
      format: "toml",
      document: { project_id: "x" },
      expected: undefined,
    },
    {
      name: "ignores a directive that follows a table header",
      text: `[db]\n#:schema ${versioned("2")}\n`,
      format: "toml",
      document: { db: {} },
      expected: undefined,
    },
    {
      name: "ignores a comment that only looks like a directive",
      text: `# :schema ${versioned("2")}\n`,
      format: "toml",
      document: {},
      expected: undefined,
    },
    {
      name: "falls back to a top-level $schema key in TOML",
      text: `"$schema" = "${versioned("2")}"\n`,
      format: "toml",
      document: { $schema: versioned("2") },
      expected: { ref: versioned("2"), version: 2n },
    },
    {
      name: "prefers the TOML directive over the $schema key",
      text: `#:schema ${versioned("1")}\n"$schema" = "${versioned("5")}"\n`,
      format: "toml",
      document: { $schema: versioned("5") },
      expected: { ref: versioned("1"), version: 1n },
    },
    {
      name: "ignores a non-string $schema",
      text: "",
      format: "json",
      document: { $schema: 2 },
      expected: undefined,
    },
    {
      name: "returns undefined when nothing is declared",
      text: "[db]\n",
      format: "toml",
      document: { db: {} },
      expected: undefined,
    },
    {
      name: "keeps every digit of a version beyond the safe integer range",
      text: "",
      format: "json",
      document: { $schema: versioned("99999999999999999999") },
      expected: { ref: versioned("99999999999999999999"), version: 99999999999999999999n },
    },
    {
      name: "reads the legacy docs URL as v1",
      text: "",
      format: "json",
      document: { $schema: "https://supabase.com/docs/cli/config.schema.json" },
      expected: { ref: "https://supabase.com/docs/cli/config.schema.json", version: 1n },
    },
    {
      name: "reads a node_modules package path with forward slashes as v1",
      text: "",
      format: "json",
      document: { $schema: "../node_modules/@supabase/config/schema.json" },
      expected: { ref: "../node_modules/@supabase/config/schema.json", version: 1n },
    },
    {
      name: "reads a node_modules package path with backslashes as v1",
      text: "",
      format: "json",
      document: { $schema: "..\\node_modules\\@supabase\\config\\schema.json" },
      expected: { ref: "..\\node_modules\\@supabase\\config\\schema.json", version: 1n },
    },
    {
      name: "reads the built dist/schema.json path with forward slashes as v1",
      text: "",
      format: "json",
      document: { $schema: "../node_modules/@supabase/config/dist/schema.json" },
      expected: { ref: "../node_modules/@supabase/config/dist/schema.json", version: 1n },
    },
    {
      name: "reads the built dist/schema.json path with backslashes as v1",
      text: "",
      format: "json",
      document: { $schema: "..\\node_modules\\@supabase\\config\\dist\\schema.json" },
      expected: {
        ref: "..\\node_modules\\@supabase\\config\\dist\\schema.json",
        version: 1n,
      },
    },
    ...[
      versioned("0"),
      versioned("01"),
      versioned("-1"),
      versioned("1.5"),
      versioned(""),
      "http://supabase.com/schemas/config/v2.json",
      `${versioned("2")}?x=1`,
      `${versioned("2")}#top`,
      "https://example.com/x.json",
      "./node_modules/@supabase/config/schema.json.bak",
      "./node_modules/@supabase/config/dist/other/schema.json",
    ].map((ref) => ({
      name: `treats ${ref} as unrecognized`,
      text: "",
      format: "json" as const,
      document: { $schema: ref },
      expected: { ref, version: undefined },
    })),
  ];

  test.each(cases)("$name", ({ text, format, document, expected }) => {
    expect(readCliConfigSchemaDeclaration(text, format, document)).toEqual(expected);
  });
});
