import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { rootCommand } from "../../cli/root.ts";
import { checkDocsExamples } from "../../docs/docs-examples.ts";
import type { DocsSpec } from "../../docs/docs-spec.ts";
import { exampleArgv, parseExample } from "./parse-example.ts";

describe("exampleArgv", () => {
  it.each([
    ["supabase init", ["init"]],
    ["supabase sso show abc \\\n  --remote=ref", ["sso", "show", "abc", "--remote=ref"]],
    [
      "supabase db push --remote='postgres://u:p@h/db'",
      ["db", "push", "--remote=postgres://u:p@h/db"],
    ],
    ['supabase gen types --lang "type script"', ["gen", "types", "--lang", "type script"]],
    ["supabase gen types > types.ts", ["gen", "types"]],
    ["SUPABASE_ACCESS_TOKEN=x supabase projects list", ["projects", "list"]],
  ])("splits %j into argv", (code, argv) => {
    expect(exampleArgv(code)).toEqual(argv);
  });

  it("skips examples that don't run supabase", () => {
    expect(exampleArgv("npx supabase init")).toBeUndefined();
  });
});

describe("parseExample", () => {
  it.effect("parses a valid example without running the handler", () =>
    Effect.gen(function* () {
      const result = yield* parseExample(rootCommand, [
        "branches",
        "delete",
        "my-branch",
        "--project-ref",
        "abcdefghijklmnopqrst",
      ]);
      expect(result).toEqual({ _tag: "Parsed" });
    }),
  );

  it.effect.each<{ readonly argv: ReadonlyArray<string>; readonly message: string }>([
    {
      argv: ["branches", "delete", "my-branch", "--no-such-flag"],
      message: "Unrecognized flag: --no-such-flag",
    },
    { argv: ["branches", "nuke"], message: 'Unknown subcommand "nuke"' },
  ])("reports $argv as invalid", ({ argv, message }) =>
    Effect.gen(function* () {
      const result = yield* parseExample(rootCommand, argv);
      expect(result._tag).toBe("Invalid");
      if (result._tag === "Invalid") expect(result.messages.join("\n")).toContain(message);
    }),
  );
});

describe("checkDocsExamples", () => {
  const specWith = (code: string): DocsSpec => ({
    clispec: "001",
    info: {
      id: "cli",
      version: "latest",
      title: "",
      language: "",
      source: "",
      bugs: "",
      spec: "",
      description: "",
      tags: [],
    },
    flags: [],
    commands: [
      {
        id: "supabase-branches-delete",
        title: "supabase branches delete",
        summary: "",
        description: "",
        examples: [{ code }],
        tags: [],
        links: [],
        subcommands: [],
        flags: [],
      },
    ],
  });

  it.effect("fails the docs build on an example with a renamed flag", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        checkDocsExamples(rootCommand, specWith("supabase branches delete main --project-id x")),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("--project-id");
    }),
  );
});
