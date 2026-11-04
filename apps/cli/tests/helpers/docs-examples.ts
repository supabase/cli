import { Ajv2020 } from "ajv/dist/2020.js";
import { Data, Effect, FileSystem, type JsonSchema, Path, Result } from "effect";

import { loadDocsBundle } from "../../scripts/docs-bundle.ts";
import type { DocsExample } from "../../src/docs/docs-spec.ts";
import { stripAnsi } from "./ansi.ts";

export interface PublishedDocsExample {
  /** The command path as published, e.g. `supabase migration list`. */
  readonly command: string;
  readonly example: DocsExample;
}

/** Every example the reference generator publishes, read from the same bundle it emits. */
export const publishedDocsExamples = loadDocsBundle({
  version: "0.0.0-docs-examples",
  prerelease: false,
  major: 2,
}).pipe(
  Effect.map((bundle) =>
    bundle.spec.commands.flatMap((command) =>
      (command.examples ?? []).map((example): PublishedDocsExample => ({
        command: command.title,
        example,
      })),
    ),
  ),
);

type ShellToken =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "separator" }
  | { readonly kind: "redirect" };

const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`", "\n"]);

/** Command boundaries; `$(` and `<(` open a nested command that `)` closes. */
const SEPARATORS = new Set(["\n", ";", "|", "&", "&&", "||", "(", ")", "$(", "<("]);

/** A docs placeholder such as `<project-ref>`, which reads as a literal value rather than a redirection. */
const DOCS_PLACEHOLDER = /^<[A-Za-z][\w.-]*>/;

/** POSIX-shell-style words, command separators and redirections. */
function shellTokens(code: string): ReadonlyArray<ShellToken> {
  const tokens: Array<ShellToken> = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };
  let index = 0;
  while (index < code.length) {
    const char = code.charAt(index);
    const pair = code.slice(index, index + 2);
    const placeholder = DOCS_PLACEHOLDER.exec(code.slice(index))?.[0];
    if (char === "\\") {
      const next = code.charAt(index + 1);
      if (next !== "\n" && next !== "") {
        word += next;
        inWord = true;
      }
      index += 2;
    } else if (char === "'") {
      const end = code.indexOf("'", index + 1);
      if (end === -1) throw new Error("unterminated single quote");
      word += code.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '"') {
      inWord = true;
      index += 1;
      while (index < code.length && code.charAt(index) !== '"') {
        const next = code.charAt(index + 1);
        if (code.charAt(index) === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(next)) {
          if (next !== "\n") word += next;
          index += 2;
        } else {
          word += code.charAt(index);
          index += 1;
        }
      }
      if (index >= code.length) throw new Error("unterminated double quote");
      index += 1;
    } else if (char === "#" && !inWord) {
      const newline = code.indexOf("\n", index);
      index = newline === -1 ? code.length : newline;
    } else if (char === " " || char === "\t") {
      flush();
      index += 1;
    } else if (char === "<" && placeholder !== undefined) {
      word += placeholder;
      inWord = true;
      index += placeholder.length;
    } else if (SEPARATORS.has(pair) || SEPARATORS.has(char)) {
      flush();
      tokens.push({ kind: "separator" });
      index += SEPARATORS.has(pair) ? 2 : 1;
    } else if (char === ">" || char === "<") {
      // A leading file descriptor (`2>`) belongs to the redirection, not to the command's words.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      flush();
      while (code.charAt(index) === ">" || code.charAt(index) === "<") index += 1;
      if (code.charAt(index) === "&") index += 1;
      tokens.push({ kind: "redirect" });
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  flush();
  return tokens;
}

/**
 * The argv of each `supabase` invocation in a docs example's shell `code`, without the leading
 * `supabase`: comments, line continuations, env assignments, pipes and redirections are dropped.
 */
export function supabaseInvocations(code: string): ReadonlyArray<ReadonlyArray<string>> {
  const commands: Array<Array<string>> = [[]];
  let skipRedirectTarget = false;
  for (const token of shellTokens(code)) {
    if (token.kind === "separator") {
      commands.push([]);
    } else if (token.kind === "redirect") {
      skipRedirectTarget = true;
    } else if (skipRedirectTarget) {
      skipRedirectTarget = false;
    } else {
      commands.at(-1)?.push(token.value);
    }
  }
  return commands.flatMap((words) => {
    const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    return start !== -1 && words[start] === "supabase" ? [words.slice(start + 1)] : [];
  });
}

/** Whether a `supabase` argv selects `--output-format json`, the mode `withDocs` `jsonOutput` describes. */
export function requestsJsonOutput(argv: ReadonlyArray<string>): boolean {
  return argv.some(
    (word, index) =>
      word === "--output-format=json" || (word === "--output-format" && argv[index + 1] === "json"),
  );
}

/** Every way `stdout` fails to be one JSON document matching `schema`, as `<pointer> <problem>` lines. */
export function jsonOutputViolations(
  schema: JsonSchema.JsonSchema,
  stdout: string,
): ReadonlyArray<string> {
  const parsed = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isFailure(parsed)) return [`stdout is not a JSON document: ${String(parsed.failure)}`];
  const validate = new Ajv2020({ allErrors: true, verbose: true }).compile(schema);
  if (validate(parsed.success)) return [];
  return (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? "is invalid"} (schema ${error.schemaPath}, got ${JSON.stringify(error.data)})`,
  );
}

/** Replaces each `[from, to]` occurrence; used to swap run-specific paths and URLs for stable text. */
export function substitute(
  text: string,
  substitutions: ReadonlyArray<readonly [string, string]>,
): string {
  return substitutions.reduce((current, [from, to]) => current.replaceAll(from, to), text);
}

/** The text recorded in a docs `response`: ANSI-free, LF line endings, no trailing spaces. */
export function recordableOutput(output: string): string {
  return stripAnsi(output)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/** Masks values that legitimately differ between runs, so they never fail a comparison. */
export function comparableOutput(output: string): string {
  return recordableOutput(output)
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replaceAll(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<timestamp>",
    );
}

export class DocsExampleSourceError extends Data.TaggedError("DocsExampleSourceError")<{
  readonly message: string;
}> {}

const escapeTemplateLiteral = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

/** Index of the backtick closing the template literal whose body starts at `start`, or -1. */
function templateLiteralEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source.charAt(index) === "\\") index += 1;
    else if (source.charAt(index) === "`") return index;
  }
  return -1;
}

/**
 * Rewrites the `response` template literal of example `exampleId` in the command's
 * `src/commands/<path>/<leaf>.command.ts`, the file every command's `withDocs` call lives in.
 */
export const rewriteRecordedResponse = Effect.fn("docsExamples.rewriteRecordedResponse")(
  function* (options: {
    readonly commandPath: ReadonlyArray<string>;
    readonly exampleId: string;
    readonly response: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const leaf = options.commandPath.at(-1) ?? "";
    const file = path.resolve(
      import.meta.dirname,
      "../../src/commands",
      ...options.commandPath,
      `${leaf}.command.ts`,
    );
    const source = yield* fs.readFileString(file);
    const idLiteral = `id: "${options.exampleId}"`;
    const idAt = source.indexOf(idLiteral);
    if (idAt === -1 || source.indexOf(idLiteral, idAt + 1) !== -1) {
      return yield* new DocsExampleSourceError({
        message: `${file}: expected exactly one \`${idLiteral}\``,
      });
    }
    const nextIdAt = source.indexOf('id: "', idAt + idLiteral.length);
    const responseAt = source.indexOf("response: `", idAt);
    const bodyStart = responseAt + "response: `".length;
    const bodyEnd = responseAt === -1 ? -1 : templateLiteralEnd(source, bodyStart);
    if (responseAt === -1 || (nextIdAt !== -1 && responseAt > nextIdAt) || bodyEnd === -1) {
      return yield* new DocsExampleSourceError({
        message: `${file}: example "${options.exampleId}" has no \`response: \`...\`\` template literal`,
      });
    }
    yield* fs.writeFileString(
      file,
      `${source.slice(0, bodyStart)}${escapeTemplateLiteral(options.response)}${source.slice(bodyEnd)}`,
    );
  },
);
