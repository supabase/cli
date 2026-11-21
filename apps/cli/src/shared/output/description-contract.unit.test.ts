import { Exit, Option } from "effect";
import { Argument, Command, Flag, GlobalFlag, Param } from "effect/cli";
import { describe, expect, it } from "vitest";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { commandInternals, flattenSubcommands } from "../../docs/docs-introspection.ts";
import { unwrapToSingleParam } from "../../command-internal/param-introspection.ts";
import { descriptionMarkdownViolations } from "./description-markdown.ts";

function violationsForTree(root: Command.Command.Any): ReadonlyArray<string> {
  const failures: string[] = [];
  const check = (path: string, field: string, text: string | undefined) => {
    if (text === undefined) return;
    for (const violation of descriptionMarkdownViolations(text)) {
      failures.push(
        `${path}: ${field}: unsupported ${violation}; use paragraphs, inline Markdown or code blocks`,
      );
    }
  };
  const params = (
    path: string,
    field: string,
    values: ReadonlyArray<Param.AnyFlag | Param.AnyArgument>,
  ) => {
    for (const value of values) {
      const single = unwrapToSingleParam(value);
      if (single === undefined) failures.push(`${path}: ${field}: unsupported parameter shape`);
      else
        check(
          path,
          `${field}.${single.name}.description`,
          Option.getOrUndefined(single.description),
        );
    }
  };
  const visit = (command: Command.Command.Any, path: string) => {
    check(path, "description", command.description);
    check(path, "shortDescription", command.shortDescription);
    command.examples.forEach((example, index) =>
      check(path, `examples[${index}].description`, example.description),
    );
    const internals = commandInternals(command);
    params(path, "flags", internals.config.flags);
    params(path, "args", internals.config.arguments);
    params(path, "sharedFlags", internals.contextConfig.flags);
    params(
      path,
      "globalFlags",
      internals.globalFlags.map((entry) => entry.flag),
    );
    for (const child of flattenSubcommands(command)) visit(child, `${path} ${child.name}`);
  };
  visit(root, root.name);
  params(
    root.name,
    "builtInFlags",
    GlobalFlag.BuiltIns.map((entry) => entry.flag),
  );
  return failures;
}

describe("command description contract", () => {
  for (const stackBackend of ["legacy", "stack"] as const) {
    for (const computeEnabled of [false, true]) {
      it(`accepts all descriptions for ${stackBackend}, compute=${computeEnabled}`, () => {
        const root = rootCommandForFeatures({
          stackBackend,
          computeEnabled,
          projectState: Exit.succeed(stackBackend),
        });
        expect(violationsForTree(root)).toEqual([]);
      });
    }
  }

  it("reports command paths and every authored description source, including inherited flag sources", () => {
    const child = Command.make("child", {
      flag: Flag.String("flag").pipe(Flag.optional, Flag.withDescription("# bad")),
      arg: Argument.String("arg").pipe(Argument.withDescription("# bad")),
    }).pipe(
      Command.withDescription("# bad"),
      Command.withShortDescription("# bad"),
      Command.withExamples([{ command: "supabase child", description: "# bad" }]),
    );
    const root = Command.make("supabase").pipe(
      Command.withSharedFlags({
        shared: Flag.String("shared").pipe(Flag.withDescription("# bad")),
      }),
      Command.withGlobalFlags([
        GlobalFlag.Setting("global")({
          flag: Flag.Boolean("global").pipe(Flag.withDescription("# bad")),
        }),
      ]),
      Command.withSubcommands([child]),
    );
    expect(violationsForTree(root).map((failure) => failure.split(": unsupported")[0])).toEqual([
      "supabase: flags.shared.description",
      "supabase: sharedFlags.shared.description",
      "supabase: globalFlags.global.description",
      "supabase child: description",
      "supabase child: shortDescription",
      "supabase child: examples[0].description",
      "supabase child: flags.flag.description",
      "supabase child: args.arg.description",
    ]);
  });
});
