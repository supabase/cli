import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stdio,
  Terminal,
} from "effect";
import { CliError, CliOutput, Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";

class ExampleParsed extends Schema.TaggedError<ExampleParsed>()("ExampleParsed", {}) {}

const SHELL_OPERATORS: ReadonlySet<string> = new Set(["|", "||", "&&", ";", "<", ">", ">>", "<<<"]);

interface ShellWord {
  readonly text: string;
  readonly quoted: boolean;
}

function shellWords(line: string): ReadonlyArray<ShellWord> {
  const words: Array<ShellWord> = [];
  let text: string | undefined;
  let quoted = false;
  const flush = () => {
    if (text !== undefined) words.push({ text, quoted });
    text = undefined;
    quoted = false;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (/\s/.test(char)) {
      flush();
    } else if (char === "'") {
      const end = line.indexOf("'", index + 1);
      const stop = end === -1 ? line.length : end;
      text = (text ?? "") + line.slice(index + 1, stop);
      quoted = true;
      index = stop;
    } else if (char === '"') {
      text ??= "";
      quoted = true;
      for (index++; index < line.length && line.charAt(index) !== '"'; index++) {
        if (line.charAt(index) === "\\" && index + 1 < line.length) index++;
        text += line.charAt(index);
      }
    } else if (char === "\\" && index + 1 < line.length) {
      text = (text ?? "") + line.charAt(++index);
    } else {
      text = (text ?? "") + char;
    }
  }
  flush();
  return words;
}

/**
 * Splits a shell example into argv words: joins `\` line continuations, honors single and double
 * quotes anywhere in a word, and stops at the first unquoted redirection or control operator.
 * Leading `NAME=value` assignments are skipped. Returns undefined unless the command is `supabase`.
 */
export function exampleArgv(code: string): ReadonlyArray<string> | undefined {
  const line = code.replace(/\\\r?\n/g, " ").split("\n")[0] ?? "";
  const all = shellWords(line);
  const end = all.findIndex((word) => !word.quoted && SHELL_OPERATORS.has(word.text));
  const words = (end === -1 ? all : all.slice(0, end)).map((word) => word.text);
  const start = words.findIndex((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
  if (start === -1 || words[start] !== "supabase") return undefined;
  return words.slice(start + 1);
}

/** Where parsing an example stopped: before the handler, or at a parse error. */
export type ExampleParseResult =
  | { readonly _tag: "Parsed" }
  | { readonly _tag: "Invalid"; readonly messages: ReadonlyArray<string> };

const silentEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("parseExample does not read the terminal size"),
      readInput: Effect.die("parseExample does not read input"),
      readLine: Effect.die("parseExample does not read input"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("parseExample does not spawn processes")),
  ),
  CliOutput.layerPresenter({ present: () => Effect.void }),
);

function invalid(messages: ReadonlyArray<string>): ExampleParseResult {
  return { _tag: "Invalid", messages };
}

/**
 * Parses an argv (without the program name) against the command tree exactly as
 * `Command.runWith` does, including flag value decoding, and stops before any handler runs.
 * Handler services are typed as provided but never built, because the root fails with
 * `ExampleParsed` before its handler.
 */
export const parseExample = Effect.fn("CommandFacts.parseExample")(function* <
  const Name extends string,
  Input,
  ContextInput,
  E,
  R,
>(root: Command.Command<Name, Input, ContextInput, E, R>, argv: ReadonlyArray<string>) {
  const unbuiltServices = Layer.effectContext<R, never, never>(
    Effect.die("parseExample never builds handler services"),
  );
  const probe = root.pipe(
    Command.provide(unbuiltServices),
    Command.provideEffectDiscard(Effect.fail(new ExampleParsed())),
  );
  const exit = yield* Command.runWith(probe, { version: "0.0.0", renderErrors: false })(argv).pipe(
    Effect.provide(silentEnvironment),
    Effect.exit,
  );
  yield* Effect.annotateCurrentSpan("example.argv", argv.join(" "));
  if (Exit.isSuccess(exit)) return { _tag: "Parsed" } satisfies ExampleParseResult;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    if (Schema.is(ExampleParsed)(error.value)) {
      return { _tag: "Parsed" } satisfies ExampleParseResult;
    }
    if (CliError.isCliError(error.value) && error.value._tag === "ShowHelp") {
      return invalid(error.value.errors.map((cause) => cause.message));
    }
  }
  return invalid([Cause.pretty(exit.cause)]);
});
