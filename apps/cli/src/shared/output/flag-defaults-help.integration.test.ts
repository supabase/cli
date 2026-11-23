import { describe, expect, it } from "@effect/vitest";
import { Config, Console, Effect, Layer, Option, Ref, Schema } from "effect";
import { CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { emptyEnv, fakeConsole } from "../../../tests/helpers/mocks.ts";
import { FlagDocumentation } from "../../command-internal/flag-documentation.ts";
import { textCliOutputFormatter } from "./text-formatter.ts";
import { jsonCliOutputFormatter } from "./json-formatter.ts";

const global = GlobalFlag.Setting("fixture-mode")({
  flag: Flag.String("fixture-mode").pipe(Flag.withDefault("global-mode")),
});
const child = Command.make(
  "child",
  {
    count: Flag.Int("count").pipe(Flag.withDescription("Count."), Flag.withDefault(42)),
    disabled: Flag.Boolean("disabled").pipe(Flag.withDefault(false)),
    zero: Flag.Int("zero").pipe(Flag.withDefault(0)),
    empty: Flag.String("empty").pipe(Flag.atLeast(0), Flag.withDefault([])),
    labeled: Flag.Boolean("labeled").pipe(
      Flag.withDefault(false),
      Flag.annotate(FlagDocumentation, { helpDefault: "false" }),
    ),
    stringFalse: Flag.String("string-false").pipe(Flag.withDefault("false")),
    stringZero: Flag.String("string-zero").pipe(Flag.withDefault("0")),
    stringArray: Flag.String("string-array").pipe(Flag.withDefault("[]")),
    branch: Flag.String("branch").pipe(
      Flag.withDefault("main"),
      Flag.withDescription("Select the default branch for previews"),
    ),
    literal: Flag.String("literal").pipe(Flag.withDefault("*daily* _raw_ `code` [x](url)")),
    repeated: Flag.String("repeated").pipe(Flag.withDefault("first"), Flag.atLeast(2)),
    effectful: Flag.String("effectful").pipe(Flag.withDefault(Effect.die("default executed"))),
    config: Flag.String("config").pipe(Flag.withFallbackConfig(Config.String("HELP_SECRET"))),
    handler: Flag.String("handler").pipe(
      Flag.optional,
      Flag.annotate(FlagDocumentation, { defaultValue: "handler-value" }),
    ),
    sub: Flag.String("sub").pipe(
      Flag.optional,
      Flag.annotate(FlagDocumentation, { defaultValue: "anonymous", helpDefault: false }),
    ),
    hidden: Flag.String("hidden").pipe(Flag.withDefault("hidden-value"), Flag.withHidden),
  },
  () => Effect.void,
);
const root = Command.make("fixture").pipe(
  Command.withSharedFlags({ shared: Flag.String("shared").pipe(Flag.withDefault("shared-value")) }),
  Command.withGlobalFlags([global]),
  Command.withSubcommands([child]),
);

const helpFor = (
  formatter: CliOutput.Formatter,
  command: Command.Command<"fixture", never, unknown> = root,
  args: ReadonlyArray<string> = ["child", "--help"],
) =>
  Effect.gen(function* () {
    const { console, calls } = fakeConsole();
    yield* Command.runWith(command, { version: "test" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          emptyEnv(),
          Layer.succeed(Console.Console, console),
          CliOutput.layer(formatter),
        ),
      ),
    );
    return calls.join("\n").replace(/^log:/, "");
  });

describe("flag defaults in help", () => {
  it.effect("keeps documentation exceptions out of parsing and handler values", () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<unknown>(undefined);
      const command = Command.make(
        "fixture",
        {
          value: Flag.Literals("value", ["a", "b", "c"]).pipe(
            Flag.withDefault("b"),
            Flag.annotate(FlagDocumentation, { defaultValue: "a", choices: ["a"] }),
          ),
          omitted: Flag.String("omitted").pipe(
            Flag.optional,
            Flag.annotate(FlagDocumentation, { required: true }),
          ),
        },
        (flags) => Ref.set(observed, flags),
      );
      yield* Command.runWith(command, { version: "test" })([]).pipe(Effect.provide(emptyEnv()));
      expect(yield* Ref.get(observed)).toEqual({ value: "b", omitted: Option.none() });
      yield* Command.runWith(command, { version: "test" })(["--value", "c"]).pipe(
        Effect.provide(emptyEnv()),
      );
      expect(yield* Ref.get(observed)).toEqual({ value: "c", omitted: Option.none() });
    }),
  );

  it.effect(
    "shows literal and handler defaults across local, inherited and global text flags",
    () =>
      Effect.gen(function* () {
        const text = yield* helpFor(
          textCliOutputFormatter({ rootCommand: root, args: ["child", "--help"] }),
        );
        expect(text).toContain("Count. (default: 42)");
        const row = (name: string) => text.split("\n").find((line) => line.includes(`--${name} `));
        for (const name of ["disabled", "zero", "empty", "repeated"]) {
          expect(row(name)).toBeDefined();
          expect(row(name)).not.toContain("(default:");
        }
        expect(row("labeled")).toContain("(default: false)");
        expect(row("string-false")).toContain("(default: false)");
        expect(row("string-zero")).toContain("(default: 0)");
        expect(row("string-array")).toContain("(default: [])");
        expect(text).toContain("(default: handler-value)");
        expect(text).toContain("(default: shared-value)");
        expect(text).toContain("(default: global-mode)");
        expect(text).not.toContain("anonymous");
        expect(text).not.toContain("hidden-value");
        expect(text).not.toContain("default executed");
        expect(text).not.toContain("HELP_SECRET");
      }),
  );

  it.effect("preserves descriptive prose alongside the default value", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(
        textCliOutputFormatter({ rootCommand: root, args: ["child", "--help"] }),
      );
      expect(text).toContain("Select the default branch for previews (default: main)");
    }),
  );

  it.effect("appends string defaults literally after Markdown rendering", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(
        textCliOutputFormatter({ rootCommand: root, args: ["child", "--help"] }),
      );
      expect(text).toContain("(default: *daily* _raw_ `code` [x](url))");
    }),
  );

  it.effect("shows shared defaults on the declaring command's own help", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(
        textCliOutputFormatter({ rootCommand: root, args: ["--help"] }),
        root,
        ["--help"],
      );
      expect(text).toContain("--shared");
      expect(text).toContain("(default: shared-value)");
      expect(text).not.toContain("INHERITED FLAGS");
    }),
  );

  it.effect("uses the declaration owning each local and inherited row", () =>
    Effect.gen(function* () {
      const leaf = Command.make("leaf", {
        suppressed: Flag.String("suppressed").pipe(
          Flag.withDefault("local-suppressed"),
          Flag.annotate(FlagDocumentation, { helpDefault: false }),
        ),
        absent: Flag.String("absent").pipe(Flag.optional),
        local: Flag.String("local").pipe(Flag.withDefault("local-value")),
      });
      const middle = Command.make("middle").pipe(
        Command.withSharedFlags({
          inherited: Flag.String("inherited").pipe(Flag.withDefault("near-value")),
        }),
        Command.withSubcommands([leaf]),
      );
      const fixture = Command.make("fixture").pipe(
        Command.withSharedFlags({
          suppressed: Flag.String("suppressed").pipe(Flag.withDefault("ancestor-suppressed")),
          absent: Flag.String("absent").pipe(Flag.withDefault("ancestor-absent")),
          local: Flag.String("local").pipe(Flag.withDefault("ancestor-local")),
          inherited: Flag.String("inherited").pipe(Flag.withDefault("root-value")),
        }),
        Command.withSubcommands([Command.make("spacer").pipe(Command.withSubcommands([middle]))]),
      );
      const text = yield* helpFor(
        textCliOutputFormatter({
          rootCommand: fixture,
          args: ["spacer", "middle", "leaf", "--help"],
        }),
        fixture,
        ["spacer", "middle", "leaf", "--help"],
      );
      expect(text).toContain("--suppressed");
      expect(text).toContain("--absent");
      expect(text).toContain("(default: local-value)");
      expect(text).toContain("(default: root-value)");
      expect(text).not.toContain("ancestor-");
      expect(text).not.toContain("local-suppressed");
      expect(text).not.toContain("near-value");
    }),
  );

  it("rejects direct shared and child name collisions", () => {
    expect(() =>
      Command.make("fixture").pipe(
        Command.withSharedFlags({ value: Flag.String("value") }),
        Command.withSubcommands([Command.make("child", { value: Flag.String("value") })]),
      ),
    ).toThrow('Duplicate flag name "value" in parent command "fixture" and subcommand "child"');
  });

  it.effect("keeps JSON help flag fields and descriptions unchanged", () =>
    Effect.gen(function* () {
      const printed = yield* helpFor(
        jsonCliOutputFormatter({ rootCommand: root, args: ["child", "--help"] }),
      );
      const help = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            doc: Schema.Struct({ flags: Schema.Array(Schema.Unknown) }),
          }),
        ),
      )(printed);
      expect(help.doc.flags).toContainEqual({
        name: "count",
        aliases: [],
        type: "integer",
        description: { _id: "Option", _tag: "Some", value: "Count." },
        required: false,
      });
      expect(printed).not.toContain("default:");
      expect(printed).not.toContain("handler-value");
      expect(printed).not.toContain("anonymous");
    }),
  );
});
