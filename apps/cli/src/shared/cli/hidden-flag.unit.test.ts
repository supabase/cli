import { Context, Effect, Layer, Option } from "effect";
import { CliOutput, Command, Flag, type HelpDoc } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { legacyDbCommand } from "../../legacy/commands/db/db.command.ts";
import { LegacyGoProxy } from "../legacy/go-proxy.service.ts";
import { textCliOutputFormatter } from "../output/text-formatter.ts";
import {
  LegacyHiddenFlags,
  stripHiddenFlagsFromHelpDoc,
  withHidden,
  withHiddenFromConfig,
} from "./hidden-flag.ts";

const flagDoc = (name: string): HelpDoc.FlagDoc => ({
  name,
  aliases: [`--${name}`],
  type: "boolean",
  description: Option.none(),
  required: false,
});

const helpDoc = (overrides: Partial<HelpDoc.HelpDoc>): HelpDoc.HelpDoc => ({
  description: "",
  usage: "",
  flags: [],
  annotations: Context.empty(),
  ...overrides,
});

const helpDocWithHidden = (
  hidden: ReadonlyArray<string>,
  overrides: Partial<HelpDoc.HelpDoc>,
): HelpDoc.HelpDoc =>
  helpDoc({
    ...overrides,
    annotations: Context.make(LegacyHiddenFlags, new Set(hidden)),
  });

// Reach into the internal command shape to obtain the help doc the formatter
// would render. Effect builds this from `Command.annotations`, which is the
// contract `withHiddenFromConfig` relies on.
interface CommandImpl {
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => HelpDoc.HelpDoc;
}
const buildHelpDoc = <Name extends string, Input, ContextInput, E, R>(
  cmd: Command.Command<Name, Input, ContextInput, E, R>,
): HelpDoc.HelpDoc => (cmd as unknown as CommandImpl).buildHelpDoc([]);

function mockLegacyGoProxy() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
      }),
  });

  return { layer, calls };
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyBranchesCommand, legacyDbCommand]),
);

describe("withHidden", () => {
  it("returns the same flag instance", () => {
    const flag = Flag.boolean("legacy-bundle");
    expect(withHidden(flag)).toBe(flag);
  });

  it("does not register flag names globally — only commands wired via withHiddenFromConfig hide them", () => {
    withHidden(Flag.boolean("stray"));

    const stripped = stripHiddenFlagsFromHelpDoc(helpDoc({ flags: [flagDoc("stray")] }));
    expect(stripped.flags.map((f) => f.name)).toEqual(["stray"]);
  });
});

describe("withHiddenFromConfig", () => {
  it("strips wrapped flags from the command's help doc", () => {
    const config = {
      plan: withHidden(Flag.string("plan").pipe(Flag.optional)),
      visible: Flag.boolean("visible"),
    } as const;

    const cmd = Command.make("demo", config).pipe(withHiddenFromConfig(config));
    const doc = stripHiddenFlagsFromHelpDoc(buildHelpDoc(cmd));

    expect(doc.flags.map((f) => f.name)).toEqual(["visible"]);
  });

  it("scopes hidden-ness to the wrapping command — same flag name in another command stays visible", () => {
    const hiddenConfig = {
      interactive: withHidden(Flag.boolean("interactive")),
    } as const;
    const visibleConfig = {
      interactive: Flag.boolean("interactive"),
    } as const;

    const hiddenCmd = Command.make("create", hiddenConfig).pipe(withHiddenFromConfig(hiddenConfig));
    const visibleCmd = Command.make("init", visibleConfig).pipe(
      withHiddenFromConfig(visibleConfig),
    );

    expect(stripHiddenFlagsFromHelpDoc(buildHelpDoc(hiddenCmd)).flags.map((f) => f.name)).toEqual(
      [],
    );
    expect(stripHiddenFlagsFromHelpDoc(buildHelpDoc(visibleCmd)).flags.map((f) => f.name)).toEqual([
      "interactive",
    ]);
  });

  it("is a no-op when the config contains no hidden flags", () => {
    const config = { visible: Flag.boolean("visible") } as const;
    const cmd = Command.make("demo", config);
    const piped = cmd.pipe(withHiddenFromConfig(config));

    expect(piped).toBe(cmd);
  });

  it("collects names through Flag combinators like optional", () => {
    const config = {
      plan: withHidden(Flag.string("plan").pipe(Flag.optional)),
    } as const;
    const cmd = Command.make("demo", config).pipe(withHiddenFromConfig(config));
    const annotated = Context.get(buildHelpDoc(cmd).annotations, LegacyHiddenFlags);

    expect([...annotated]).toEqual(["plan"]);
  });
});

describe("stripHiddenFlagsFromHelpDoc", () => {
  it("returns the doc unchanged when annotations are empty", () => {
    const doc = helpDoc({ flags: [flagDoc("foo")] });
    expect(stripHiddenFlagsFromHelpDoc(doc)).toBe(doc);
  });

  it("filters both flags and globalFlags by the doc's annotation", () => {
    const doc = helpDocWithHidden(["preview", "plan"], {
      flags: [flagDoc("plan"), flagDoc("visible")],
      globalFlags: [flagDoc("preview"), flagDoc("verbose")],
    });

    const stripped = stripHiddenFlagsFromHelpDoc(doc);
    expect(stripped.flags.map((f) => f.name)).toEqual(["visible"]);
    expect(stripped.globalFlags?.map((f) => f.name)).toEqual(["verbose"]);
  });

  it("leaves docs without globalFlags untouched in that field", () => {
    const doc = helpDocWithHidden(["foo"], { flags: [flagDoc("foo"), flagDoc("bar")] });
    const stripped = stripHiddenFlagsFromHelpDoc(doc);

    expect(stripped.globalFlags).toBeUndefined();
    expect(stripped.flags.map((f) => f.name)).toEqual(["bar"]);
  });
});

describe("legacy hidden subcommands", () => {
  it("omits hidden branch and db subcommands from help docs", () => {
    const branchesHelp = buildHelpDoc(legacyBranchesCommand);
    expect(branchesHelp.subcommands?.[0]?.commands.map((command) => command.name)).toEqual([
      "list",
      "create",
      "get",
      "update",
      "pause",
      "unpause",
      "delete",
    ]);

    const dbHelp = buildHelpDoc(legacyDbCommand);
    expect(dbHelp.subcommands?.[0]?.commands.map((command) => command.name)).toEqual([
      "diff",
      "dump",
      "push",
      "pull",
      "reset",
      "lint",
      "start",
      "query",
      "advisors",
      "schema",
    ]);
  });

  it("still executes hidden subcommands by exact name", async () => {
    const proxy = mockLegacyGoProxy();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["branches", "disable"]);
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "test"]);
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(["db", "branch", "list"]);
        yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "db",
          "remote",
          "changes",
        ]);
      }).pipe(
        Effect.provide(Layer.mergeAll(proxy.layer, CliOutput.layer(textCliOutputFormatter()))),
      ) as Effect.Effect<void>,
    );

    expect(proxy.calls).toEqual([
      ["branches", "disable"],
      ["db", "test"],
      ["db", "branch", "list"],
      ["db", "remote", "changes"],
    ]);
  });
});
