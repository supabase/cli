import { describe, expect, test } from "vitest";
import { findUnknownCliConfigKeys } from "./unknown-keys.ts";

describe("findUnknownCliConfigKeys", () => {
  const unknown: ReadonlyArray<{
    readonly name: string;
    readonly document: unknown;
    readonly expected: ReadonlyArray<ReadonlyArray<string>>;
  }> = [
    { name: "a top-level key", document: { bogus: 1 }, expected: [["bogus"]] },
    { name: "a key in a table", document: { api: { foo: 1 } }, expected: [["api", "foo"]] },
    {
      name: "a key in a function entry",
      document: { functions: { hello: { foo: true } } },
      expected: [["functions", "hello", "foo"]],
    },
    {
      name: "a key in an external auth provider",
      document: { auth: { external: { github: { foo: 1 } } } },
      expected: [["auth", "external", "github", "foo"]],
    },
    {
      name: "a key in a storage bucket",
      document: { storage: { buckets: { avatars: { foo: 1 } } } },
      expected: [["storage", "buckets", "avatars", "foo"]],
    },
    {
      name: "a key in a remote",
      document: { remotes: { staging: { api: { foo: 1 } } } },
      expected: [["remotes", "staging", "api", "foo"]],
    },
    {
      name: "a key in a remote whose name contains a dot",
      document: { remotes: { "a.b": { api: { foo: 1 } } } },
      expected: [["remotes", "a.b", "api", "foo"]],
    },
    {
      name: "unknown keys in the base and in a remote, sorted",
      document: { bogus: 1, api: { foo: 1 }, remotes: { staging: { project_id: "x", nope: 1 } } },
      expected: [["api", "foo"], ["bogus"], ["remotes", "staging", "nope"]],
    },
    {
      name: "an unknown key beside a type error elsewhere",
      document: { bogus: 1, api: { port: "not a number" } },
      expected: [["bogus"]],
    },
  ];

  test.each(unknown)("reports $name", ({ document, expected }) => {
    expect(findUnknownCliConfigKeys(document).map(({ path }) => path)).toEqual(expected);
  });

  const clean: ReadonlyArray<{ readonly name: string; readonly document: unknown }> = [
    { name: "an empty document", document: {} },
    { name: "a non-object document", document: "nope" },
    { name: "an undefined document", document: undefined },
    { name: "the $schema key", document: { $schema: "https://example.com/x.json" } },
    { name: "valid keys", document: { project_id: "x", api: { port: 54321 }, db: { port: 1 } } },
    {
      name: "env() strings on number and boolean fields",
      document: {
        api: { port: "env(API_PORT)", enabled: "env(API_ENABLED)" },
        auth: { enable_signup: "env(SIGNUP)" },
      },
    },
    {
      name: "a valid document with type errors elsewhere",
      document: { api: { port: "not a number" }, db: { port: [] } },
    },
    {
      name: "a remote with only valid keys",
      document: { remotes: { staging: { project_id: "x" } } },
    },
  ];

  test.each(clean)("reports nothing for $name", ({ document }) => {
    expect(findUnknownCliConfigKeys(document)).toEqual([]);
  });

  test("reports the sibling keys of the table holding an unknown key", () => {
    const [found] = findUnknownCliConfigKeys({ api: { prot: 1 } });
    expect(found?.path).toEqual(["api", "prot"]);
    expect(found?.knownKeys).toContain("port");
    expect(found?.knownKeys).not.toContain("prot");
  });

  test("reports the sibling keys of a remote table", () => {
    const [found] = findUnknownCliConfigKeys({ remotes: { staging: { api: { prot: 1 } } } });
    expect(found?.path).toEqual(["remotes", "staging", "api", "prot"]);
    expect(found?.knownKeys).toContain("port");
  });
});
