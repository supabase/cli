import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Schema } from "effect";
import { CliOutput, Command, Flag } from "effect/cli";

import { fakeConsole } from "../../tests/helpers/mocks.ts";
import { respondToComplete } from "../cli/complete.ts";
import { jsonCliOutputFormatter } from "../shared/output/json-formatter.ts";
import { docsCommandTree } from "../docs/docs-spec.ts";
import { textCliOutputFormatter } from "../shared/output/text-formatter.ts";
import { defineExperimentalAccess, withDeprecated } from "./command-access-policy.ts";

describe("command access policy", () => {
  it.effect(
    "retains check arguments, typed failure and success for optional experimental access",
    () =>
      Effect.gen(function* () {
        const access = defineExperimentalAccess({
          experimental: "optional",
          check: (enabled: boolean) =>
            enabled ? Effect.succeed("allowed") : Effect.fail("disabled"),
        });
        let executed = false;
        const command = Command.make("preview", { enabled: Flag.Boolean("enabled") }).pipe(
          Command.withHandler((flags) =>
            Effect.gen(function* () {
              const result = yield* access.check(flags.enabled);
              executed = result === "allowed";
            }),
          ),
          access.annotate,
        );
        const layer = Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()));
        expect(
          yield* Command.runWith(command, { version: "0" })(["--enabled=false"]).pipe(
            Effect.flip,
            Effect.provide(layer),
          ),
        ).toBe("disabled");
        expect(executed).toBe(false);
        yield* Command.runWith(command, { version: "0" })(["--enabled"]).pipe(
          Effect.provide(layer),
        );
        expect(executed).toBe(true);
      }),
  );

  it.effect("keeps a deprecated command runnable and visible in help but not the docs tree", () =>
    Effect.gen(function* () {
      let executed = false;
      const leaf = Command.make("old").pipe(
        Command.withDescription("Use the replacement instead."),
        withDeprecated,
        Command.withShortDescription("Show old data"),
        Command.withHandler(() =>
          Effect.sync(() => {
            executed = true;
          }),
        ),
      );
      const other = Command.make("other").pipe(
        Command.withShortDescription("Other data"),
        withDeprecated,
      );
      const fallback = Command.make("fallback").pipe(
        withDeprecated,
        Command.withDescription("First line\nMore detail"),
      );
      const root = Command.make("supabase").pipe(Command.withSubcommands([leaf, other, fallback]));
      const context = { rootCommand: root, args: ["--help"] };
      const { console, calls } = fakeConsole();
      const formatterLayer = (formatter: CliOutput.Formatter) =>
        Layer.mergeAll(
          BunServices.layer,
          CliOutput.layer(formatter),
          Layer.succeed(Console.Console, console),
        );
      const layer = formatterLayer(textCliOutputFormatter(context));
      yield* Command.runWith(root, { version: "0" })(["--help"]).pipe(Effect.provide(layer));
      expect(calls.join("\n")).toContain("Show old data (deprecated)");
      expect(calls.join("\n")).toContain("Other data (deprecated)");
      const rows = [
        {
          name: "old",
          description: "Use the replacement instead.",
          shortDescription: "Show old data (deprecated)",
        },
        { name: "other", description: "", shortDescription: "Other data (deprecated)" },
        {
          name: "fallback",
          description: "First line\nMore detail",
          shortDescription: "First line (deprecated)",
        },
      ];
      calls.length = 0;
      yield* Command.runWith(root, { version: "0" })(["--help"]).pipe(
        Effect.provide(formatterLayer(jsonCliOutputFormatter(context))),
      );
      const json = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        calls.join("\n").replace(/^log:/, ""),
      );
      expect(json).toHaveProperty("doc.subcommands.0.commands", rows);
      for (const prefix of [["__complete"], ["__complete", "help"]]) {
        const result = respondToComplete(root, [...prefix, ""]);
        for (const row of rows)
          expect(result?.candidates).toContainEqual({
            name: row.name,
            description: row.shortDescription,
          });
      }
      expect(executed).toBe(false);
      expect(docsCommandTree(root).has("supabase-old")).toBe(false);
      calls.length = 0;
      yield* Command.runWith(root, { version: "0" })(["old", "--help"]).pipe(Effect.provide(layer));
      expect(calls.join("\n")).toContain("Use the replacement instead.");
      expect(calls.join("\n")).not.toContain("(deprecated)");
      calls.length = 0;
      yield* Command.runWith(root, { version: "0" })(["old"]).pipe(Effect.provide(layer));
      expect(executed).toBe(true);
      expect(calls).toEqual([]);
    }),
  );
});
