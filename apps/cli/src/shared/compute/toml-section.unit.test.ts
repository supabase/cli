import { describe, expect, test } from "vitest";
import { appendTomlSection, tomlKey } from "./toml-section.ts";

describe("appendTomlSection", () => {
  test("appends a new table to an existing file without disturbing it", () => {
    const before = `# my project
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

    expect(appendTomlSection(before, "compute.api", { runtime: "node", size: "2gb" }))
      .toBe(`# my project
project_id = "demo"

[functions.hello]
verify_jwt = false

[compute.api]
runtime = "node"
size = "2gb"
`);
  });

  test("writes the table alone into an empty file", () => {
    expect(appendTomlSection("", "compute.api", { runtime: "deno" })).toBe(
      '[compute.api]\nruntime = "deno"\n',
    );
    expect(appendTomlSection("\n  \n", "compute.api", { runtime: "deno" })).toBe(
      '[compute.api]\nruntime = "deno"\n',
    );
  });

  // However the file happened to be terminated, the new table is separated by
  // exactly one blank line.
  test.each([
    ['project_id = "demo"', "no trailing newline"],
    ['project_id = "demo"\n', "one trailing newline"],
    ['project_id = "demo"\n\n\n', "several trailing newlines"],
  ])("separates the appended table with one blank line given %s", (before) => {
    expect(appendTomlSection(before, "compute.api", { runtime: "node" })).toBe(
      'project_id = "demo"\n\n[compute.api]\nruntime = "node"\n',
    );
  });

  test("escapes quotes and backslashes in values", () => {
    expect(appendTomlSection("", "compute.api", { source: 'pack"age\\api' })).toBe(
      '[compute.api]\nsource = "pack\\"age\\\\api"\n',
    );
  });

  // A path may legally contain a newline on Unix. Writing it through verbatim
  // would leave config.toml unparseable, after the directory is already on disk.
  test("escapes control characters in a written value", () => {
    const after = appendTomlSection("", "compute.api", { source: "packages/od\nd\tname" });

    expect(after).toContain('source = "packages/od\\nd\\tname"');
    expect(after).not.toContain("od\nd");
  });

  test("quotes a compute name that is not a bare key", () => {
    expect(appendTomlSection("", `compute.${tomlKey("my compute")}`, { runtime: "node" })).toBe(
      '[compute."my compute"]\nruntime = "node"\n',
    );
  });

  // Quoting a count would write a TOML string, and the config schema types
  // `instances` as a number — so the rendered file would stop loading entirely.
  test("writes a number bare rather than quoting it", () => {
    expect(appendTomlSection("", "compute.api", { size: "2gb", instances: 3 })).toBe(
      '[compute.api]\nsize = "2gb"\ninstances = 3\n',
    );
  });

  test("writes a zero count, which is a real value rather than an absent one", () => {
    expect(appendTomlSection("", "compute.api", { instances: 0 })).toBe(
      "[compute.api]\ninstances = 0\n",
    );
  });

  test("writes a header with no keys when there is nothing to set", () => {
    expect(appendTomlSection("", "compute.api", {})).toBe("[compute.api]\n");
  });
});

describe("tomlKey", () => {
  test("quotes only what TOML requires quoting", () => {
    expect(tomlKey("my-compute_1")).toBe("my-compute_1");
    expect(tomlKey("my compute")).toBe('"my compute"');
  });
});
