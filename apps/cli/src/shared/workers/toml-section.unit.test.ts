import { describe, expect, test } from "vitest";
import { appendTomlSection, tomlKey } from "./toml-section.ts";

describe("appendTomlSection", () => {
  test("appends a new table to an existing file without disturbing it", () => {
    const before = `# my project
project_id = "demo"

[functions.hello]
verify_jwt = false
`;

    expect(appendTomlSection(before, "workers.api", { runtime: "node", size: "2gb" }))
      .toBe(`# my project
project_id = "demo"

[functions.hello]
verify_jwt = false

[workers.api]
runtime = "node"
size = "2gb"
`);
  });

  test("writes the table alone into an empty file", () => {
    expect(appendTomlSection("", "workers.api", { runtime: "deno" })).toBe(
      '[workers.api]\nruntime = "deno"\n',
    );
    expect(appendTomlSection("\n  \n", "workers.api", { runtime: "deno" })).toBe(
      '[workers.api]\nruntime = "deno"\n',
    );
  });

  // However the file happened to be terminated, the new table is separated by
  // exactly one blank line.
  test.each([
    ['project_id = "demo"', "no trailing newline"],
    ['project_id = "demo"\n', "one trailing newline"],
    ['project_id = "demo"\n\n\n', "several trailing newlines"],
  ])("separates the appended table with one blank line given %s", (before) => {
    expect(appendTomlSection(before, "workers.api", { runtime: "node" })).toBe(
      'project_id = "demo"\n\n[workers.api]\nruntime = "node"\n',
    );
  });

  test("escapes quotes and backslashes in values", () => {
    expect(appendTomlSection("", "workers.api", { source: 'pack"age\\api' })).toBe(
      '[workers.api]\nsource = "pack\\"age\\\\api"\n',
    );
  });

  // A path may legally contain a newline on Unix. Writing it through verbatim
  // would leave config.toml unparseable, after the directory is already on disk.
  test("escapes control characters in a written value", () => {
    const after = appendTomlSection("", "workers.api", { source: "packages/od\nd\tname" });

    expect(after).toContain('source = "packages/od\\nd\\tname"');
    expect(after).not.toContain("od\nd");
  });

  test("quotes a worker name that is not a bare key", () => {
    expect(appendTomlSection("", `workers.${tomlKey("my worker")}`, { runtime: "node" })).toBe(
      '[workers."my worker"]\nruntime = "node"\n',
    );
  });

  // Quoting a count would write a TOML string, and the config schema types
  // `instances` as a number — so the rendered file would stop loading entirely.
  test("writes a number bare rather than quoting it", () => {
    expect(appendTomlSection("", "workers.api", { size: "2gb", instances: 3 })).toBe(
      '[workers.api]\nsize = "2gb"\ninstances = 3\n',
    );
  });

  test("writes a zero count, which is a real value rather than an absent one", () => {
    expect(appendTomlSection("", "workers.api", { instances: 0 })).toBe(
      "[workers.api]\ninstances = 0\n",
    );
  });

  test("writes a header with no keys when there is nothing to set", () => {
    expect(appendTomlSection("", "workers.api", {})).toBe("[workers.api]\n");
  });
});

describe("tomlKey", () => {
  test("quotes only what TOML requires quoting", () => {
    expect(tomlKey("my-worker_1")).toBe("my-worker_1");
    expect(tomlKey("my worker")).toBe('"my worker"');
  });
});
