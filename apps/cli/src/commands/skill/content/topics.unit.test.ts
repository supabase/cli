import { describe, expect, it } from "@effect/vitest";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Option } from "effect";
import { GlobalFlag } from "effect/cli";
import { fileURLToPath } from "node:url";

import { rootCommand } from "../../../cli/root.ts";
import { unwrapParam } from "../../../command-internal/param-introspection.ts";
import { commandInternals, userGlobalFlagParams } from "../../../docs/docs-introspection.ts";
import { walkDocsCommands } from "../../../docs/docs-spec.ts";
import { hasOptionalSubcommand } from "../../../shared/output/optional-subcommand-usage.ts";
import { renderTopic } from "../display/display.render.ts";
import { resolveTopic, topicSlugs, topics } from "./topics.ts";

const CONTENT_DIR = fileURLToPath(new URL("./", import.meta.url));
const OVERVIEW_BYTE_CAP = 6 * 1024;
const TOPIC_BYTE_CAP = 12 * 1024;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

interface PublishedCommand {
  readonly path: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  readonly takesSubcommand: boolean;
}

const flagNames = (params: ReadonlyArray<Parameters<typeof unwrapParam>[0]>) =>
  params.flatMap((param) => {
    const single = unwrapParam(param)?.single;
    if (single === undefined || single.hidden) return [];
    return [single.name, ...single.aliases];
  });

const rootFlags = flagNames([...userGlobalFlagParams(rootCommand), GlobalFlag.Help.flag]);

const published: Array<PublishedCommand> = [];
walkDocsCommands(rootCommand, (command, path, inherited, children) => {
  published.push({
    path,
    takesSubcommand: children.length > 0 && !hasOptionalSubcommand(command),
    flags: new Set([
      ...flagNames(commandInternals(command).config.flags),
      ...flagNames(inherited),
      ...rootFlags,
    ]),
  });
});

const tokenize = (line: string): Array<string> => {
  const tokens: Array<string> = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current !== "") tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (started || current !== "") tokens.push(current);
  return tokens;
};

const supabaseCommandLines = (body: string): Array<string> =>
  [...body.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((block) => (block[1] ?? "").split("\n"))
    .map((line) =>
      line
        .trim()
        .replace(/^cat\b[^|]*\|\s*/, "")
        .replace(/^(\w+=\S+\s+)+/, ""),
    )
    .filter((line) => line.startsWith("supabase "));

const resolvePublished = (tokens: ReadonlyArray<string>): PublishedCommand | undefined =>
  published
    .filter((command) => command.path.every((segment, index) => tokens[index] === segment))
    .toSorted((a, b) => b.path.length - a.path.length)[0];

const unknownSubcommand = (tokens: ReadonlyArray<string>): string | undefined => {
  const command = resolvePublished(tokens);
  const next = command === undefined ? undefined : tokens[command.path.length];
  return command?.takesSubcommand === true && next !== undefined && !next.startsWith("-")
    ? next
    : undefined;
};

describe("command line matcher", () => {
  it("rejects a misspelled subcommand of a command group", () => {
    expect(unknownSubcommand(tokenize("supabase db querry --linked"))).toBe("querry");
  });

  it("accepts a published subcommand and a positional on a leaf", () => {
    expect(unknownSubcommand(tokenize("supabase db query"))).toBeUndefined();
    expect(unknownSubcommand(tokenize("supabase skill display overview"))).toBeUndefined();
  });
});

describe("skill topic registry", () => {
  it.effect("has one content file per registered slug", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = (yield* fs.readDirectory(CONTENT_DIR))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.slice(0, -".md".length));
      expect(files.toSorted()).toEqual([...topicSlugs].toSorted());
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );

  it("resolves a topic ignoring whitespace and case", () => {
    expect(Option.map(resolveTopic(" Overview "), (topic) => topic.slug)).toEqual(
      Option.some("overview"),
    );
  });

  it("resolves an unknown topic to none", () => {
    expect(Option.isNone(resolveTopic("nope"))).toBe(true);
  });
});

describe.each(topics)("skill topic $slug content", (topic) => {
  const lines = supabaseCommandLines(topic.body);

  it("shows at least one command", () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  it("names only published commands in code blocks", () => {
    for (const line of lines) {
      const tokens = tokenize(line);
      expect(resolvePublished(tokens), line).toBeDefined();
      expect(unknownSubcommand(tokens), line).toBeUndefined();
    }
  });

  it("uses only flags the command, its parents, or the root declares", () => {
    for (const line of lines) {
      const tokens = tokenize(line);
      const command = resolvePublished(tokens);
      const flags = tokens
        .slice(command?.path.length ?? tokens.length)
        .filter((token) => token.startsWith("-"))
        .map((token) => token.split("=")[0]?.replace(/^--?/, "") ?? "");
      for (const flag of flags) {
        expect(command?.flags.has(flag), `${line}: ${flag}`).toBe(true);
      }
    }
  });

  it("keeps --yes and the v2 target flags out of code blocks", () => {
    for (const line of lines) {
      for (const banned of ["--yes", "--local", "--linked", "--project-ref", "--db-url"]) {
        expect(line).not.toContain(banned);
      }
    }
  });

  it("only points at registered topics", () => {
    for (const match of topic.body.matchAll(/supabase skill display\s+([a-z][a-z0-9-]*)/g)) {
      expect(topicSlugs).toContain(match[1]);
    }
  });

  it("renders within its size cap", () => {
    const cap = topic.slug === "overview" ? OVERVIEW_BYTE_CAP : TOPIC_BYTE_CAP;
    expect(byteLength(renderTopic(topic, "9.9.9"))).toBeLessThanOrEqual(cap);
  });
});
