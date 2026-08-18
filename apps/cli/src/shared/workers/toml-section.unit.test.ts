import { describe, expect, test } from "vitest";
import { sectionExists, tomlKey, upsertTomlSection } from "./toml-section.ts";

/** The edited text, failing the test if the edit was refused. */
function edited(text: string, header: string, values: Record<string, string>): string {
  const result = upsertTomlSection(text, header, values);
  if (result._tag !== "Edited") {
    throw new Error(`expected an edit, got Unsupported(${result.key})`);
  }
  return result.text;
}

describe("upsertTomlSection", () => {
  test("appends a new table to an existing file without disturbing it", () => {
    const before = `# my project
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

    expect(edited(before, "workers.api", { runtime: "node", size: "2gb" })).toBe(
      `# my project
project_id = "demo"

[functions.hello]
verify_jwt = false

[workers.api]
runtime = "node"
size = "2gb"
`,
    );
  });

  test("writes the table alone into an empty file", () => {
    expect(edited("   \n", "workers.api", { runtime: "deno" })).toBe(
      `[workers.api]
runtime = "deno"
`,
    );
  });

  test("rewrites an existing key in place, preserving its comment and position", () => {
    const before = `[workers.api]
# the runtime this was scaffolded on
runtime = "node"
size = "2gb"

[workers.other]
runtime = "deno"
`;

    expect(edited(before, "workers.api", { runtime: "bun" })).toBe(
      `[workers.api]
# the runtime this was scaffolded on
runtime = "bun"
size = "2gb"

[workers.other]
runtime = "deno"
`,
    );
  });

  test("appends a new key after the table's last content line, keeping the blank separator", () => {
    const before = `[workers.api]
runtime = "node"

[workers.other]
runtime = "deno"
`;

    expect(edited(before, "workers.api", { size: "4gb" })).toBe(
      `[workers.api]
runtime = "node"
size = "4gb"

[workers.other]
runtime = "deno"
`,
    );
  });

  test("matches a quoted key and the caller's own indentation", () => {
    const before = `[workers.api]
  "runtime"  = "node"
`;

    expect(edited(before, "workers.api", { runtime: "python" })).toBe(
      `[workers.api]
  runtime  = "python"
`,
    );
  });

  test("escapes quotes and backslashes in values", () => {
    expect(edited("", "workers.api", { source: 'a"b\\c' })).toBe(
      `[workers.api]
source = "a\\"b\\\\c"
`,
    );
  });

  test("matches a header with whitespace inside the brackets and a trailing comment", () => {
    // TOML treats these as the same table; appending a second one would make the
    // file invalid.
    expect(
      edited('[ workers.api ]  # mine\nruntime = "node"\n', "workers.api", { runtime: "bun" }),
    ).toBe('[ workers.api ]  # mine\nruntime = "bun"\n');
  });

  test("keeps a comment trailing the value it rewrites", () => {
    expect(
      edited('[workers.api]\nruntime = "node" # keep me\n', "workers.api", { runtime: "bun" }),
    ).toBe('[workers.api]\nruntime = "bun" # keep me\n');
  });

  test("does not mistake a # inside a string for a comment", () => {
    expect(edited('[workers.api]\nsource = "a#b"\n', "workers.api", { source: "c#d" })).toBe(
      '[workers.api]\nsource = "c#d"\n',
    );
  });

  test("refuses a value that spans lines rather than stranding its continuation", () => {
    const before = '[workers.api]\nruntime = [\n  "a",\n]\n';
    const result = upsertTomlSection(before, "workers.api", { runtime: "bun" });

    expect(result._tag).toBe("Unsupported");
    if (result._tag === "Unsupported") {
      expect(result.key).toBe("runtime");
    }
  });

  test("refuses an unterminated multi-line string the same way", () => {
    const result = upsertTomlSection(
      '[workers.api]\nsource = """\nstill going\n"""\n',
      "workers.api",
      { source: "packages/api" },
    );

    expect(result._tag).toBe("Unsupported");
  });

  test("returns the text untouched when there is nothing to set", () => {
    expect(edited('project_id = "demo"\n', "workers.api", {})).toBe('project_id = "demo"\n');
  });
});

describe("sectionExists", () => {
  test("finds a standalone table header and ignores a dotted key of the same name", () => {
    expect(sectionExists('[workers.api]\nruntime = "node"\n', "workers.api")).toBe(true);
    expect(sectionExists('workers.api.runtime = "node"\n', "workers.api")).toBe(false);
  });
});

describe("tomlKey", () => {
  test("quotes only what TOML requires quoting", () => {
    expect(tomlKey("my-worker_1")).toBe("my-worker_1");
    expect(tomlKey("my worker")).toBe('"my worker"');
  });
});
