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
    authored: Flag.String("authored").pipe(
      Flag.withDefault("old"),
      Flag.withDescription("Authored (default old)"),
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

const helpFor = (formatter: CliOutput.Formatter) =>
  Effect.gen(function* () {
    const { console, calls } = fakeConsole();
    yield* Command.runWith(root, { version: "test" })(["child", "--help"]).pipe(
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
          value: Flag.Literals("value", ["a", "b"]).pipe(
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
      yield* Command.runWith(command, { version: "test" })(["--value", "b"]).pipe(
        Effect.provide(emptyEnv()),
      );
      expect(yield* Ref.get(observed)).toEqual({ value: "b", omitted: Option.none() });
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
        expect(text).toContain("(default: handler-value)");
        expect(text).toContain("(default: shared-value)");
        expect(text).toContain("(default: global-mode)");
        expect(text).toContain("Authored (default old)");
        expect(text).not.toContain("Authored (default old) (default:");
        expect(text).not.toContain("anonymous");
        expect(text).not.toContain("hidden-value");
        expect(text).not.toContain("default executed");
        expect(text).not.toContain("HELP_SECRET");
      }),
  );

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
