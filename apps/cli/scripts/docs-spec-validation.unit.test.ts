import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { stringify } from "yaml";
import { validateDocsSpec } from "./docs-spec-validation.ts";

const root = Command.make("supabase").pipe(
  Command.withSubcommands([Command.make("example"), Command.make("hidden").pipe(Command.unlisted)]),
);
const command = {
  id: "supabase-example",
  title: "supabase example",
  summary: "Example",
  description: "",
  tags: [],
  links: [],
  subcommands: [],
  flags: [],
};
const spec = {
  clispec: "001",
  info: {
    id: "cli",
    version: "1.0.0",
    title: "Supabase CLI",
    language: "sh",
    source: "https://github.com/supabase/cli",
    bugs: "https://github.com/supabase/cli/issues",
    spec: "https://github.com/supabase/spec/cli_v1_commands.yaml",
    description: "",
    tags: [],
  },
  flags: [],
  commands: [command],
};

it.effect("accepts a complete small tree without requiring unlisted commands", () =>
  Effect.gen(function* () {
    const result = yield* validateDocsSpec(stringify(spec), "1.0.0", root);
    expect(result.commands.map(({ id }) => id)).toEqual(["supabase-example"]);
  }),
);

const inspectRoot = Command.make("supabase").pipe(
  Command.withSubcommands([
    Command.make("inspect").pipe(
      Command.withSubcommands([
        Command.make("db").pipe(Command.withSubcommands([Command.make("cache-hit")])),
      ]),
    ),
  ]),
);
const inspectSpec = {
  ...spec,
  commands: [
    { ...command, id: "supabase-inspect", subcommands: ["supabase-inspect-db"] },
    { ...command, id: "supabase-inspect-db" },
  ],
};

it.effect("omits excluded commands from both coverage and parent links", () =>
  Effect.gen(function* () {
    const result = yield* validateDocsSpec(stringify(inspectSpec), "1.0.0", inspectRoot);
    expect(result.commands.map(({ id }) => id)).toEqual([
      "supabase-inspect",
      "supabase-inspect-db",
    ]);
    const error = yield* validateDocsSpec(
      stringify({
        ...inspectSpec,
        commands: [...inspectSpec.commands, { ...command, id: "supabase-inspect-db-cache-hit" }],
      }),
      "1.0.0",
      inspectRoot,
    ).pipe(Effect.flip);
    expect(error.message).toContain("unexpected: supabase-inspect-db-cache-hit");
  }),
);

it.effect.each([
  ["missing child", [], "[]"],
  ["wrong existing child", ["supabase-inspect"], "[supabase-inspect]"],
  [
    "duplicate child",
    ["supabase-inspect-db", "supabase-inspect-db"],
    "[supabase-inspect-db, supabase-inspect-db]",
  ],
] as const)("rejects %s in parent links", ([, subcommands, supplied]) =>
  Effect.gen(function* () {
    const input = {
      ...inspectSpec,
      commands: inspectSpec.commands.map((entry) =>
        entry.id === "supabase-inspect" ? { ...entry, subcommands } : entry,
      ),
    };
    const error = yield* validateDocsSpec(stringify(input), "1.0.0", inspectRoot).pipe(Effect.flip);
    expect(error.message).toBe(
      `subcommand coverage mismatch for supabase-inspect. Expected: [supabase-inspect-db]; supplied: ${supplied}.`,
    );
  }),
);

it.effect.each([
  ["missing command", { ...spec, commands: [] }, "missing: supabase-example"],
  ["duplicate command", { ...spec, commands: [command, command] }, "duplicate command"],
  [
    "substituted command",
    { ...spec, commands: [{ ...command, id: "supabase-wrong" }] },
    "unexpected: supabase-wrong",
  ],
  [
    "broken subcommand link",
    { ...spec, commands: [{ ...command, subcommands: ["supabase-absent"] }] },
    "subcommand coverage mismatch",
  ],
  ["invalid command flags", { ...spec, commands: [{ ...command, flags: "wrong" }] }, "flags"],
  ["invalid example", { ...spec, commands: [{ ...command, examples: [{ code: 42 }] }] }, "code"],
  [
    "invalid global flag",
    { ...spec, flags: [{ id: "debug", name: "--debug", description: "", default_value: false }] },
    "default_value",
  ],
  [
    "invalid accepted values",
    {
      ...spec,
      flags: [
        {
          id: "output",
          name: "--output",
          description: "",
          default_value: "",
          accepted_values: [{ id: "json", name: "json", type: 1 }],
        },
      ],
    },
    "type",
  ],
  ["invalid info", { ...spec, info: { ...spec.info, title: 42 } }, "title"],
  ["invalid marker", { ...spec, clispec: "002" }, "clispec"],
] as const)("rejects %s", ([, input, message]) =>
  Effect.gen(function* () {
    const error = yield* validateDocsSpec(stringify(input), "1.0.0", root).pipe(Effect.flip);
    expect(error.message).toContain(message);
  }),
);
