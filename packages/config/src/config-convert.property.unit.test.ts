import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { printParseErrorCode, visit } from "jsonc-parser";
import * as SmolToml from "smol-toml";
import { convertCliConfigTomlToJsonc } from "./config-convert.ts";
import { parseJsonc } from "./jsonc.ts";
import { scanTomlDocument } from "./toml-scan.ts";

const SEEDS = [1, 7, 42, 2024];
const CASES_PER_SEED = 500;

const REAL_HEADERS = ["[a]", "[a.b]", "[a.c]", "[f.g]", "[s.t]", "[s]"];
const REAL_KVS = ["x = 1", "y = 2", "b.k = 3", "c.m = 4", "q = 5"];
const COMMENTED_KVS = ["# z = 3", "# w = 4", "# b.v = 5", "# d.e = 6", "# d.h = 7", "# c.n = 8"];
const COMMENTED_KVS_TAIL = [...COMMENTED_KVS, "# t.u = 9"];
const COMMENTED_HEADERS = [
  "# [a.d]",
  "# [s]",
  "# [s.t]",
  "# [a.b]",
  "# [d]",
  "# [a.d.e2]",
  "# [a]",
];
const PROSE = ["# note", "# Another note.", "# Uses the [a] table."];

const EXAMPLE_LINE = /^# (\[\[?[^\]]+\]\]?|[\w."'-]+ = .+)$/;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSource(rand: () => number): string {
  const pick = (items: ReadonlyArray<string>): string =>
    items[Math.floor(rand() * items.length)] ?? "";
  const lines: string[] = [];
  const count = 3 + Math.floor(rand() * 9);
  for (let i = 0; i < count; i++) {
    const roll = rand();
    if (roll < 0.15) {
      lines.push(pick(REAL_HEADERS));
    } else if (roll < 0.35) {
      lines.push(pick(REAL_KVS));
    } else if (roll < 0.6) {
      if (rand() < 0.3) lines.push(pick(PROSE));
      lines.push(pick(COMMENTED_KVS_TAIL));
    } else if (roll < 0.8) {
      if (rand() < 0.3) lines.push(pick(PROSE));
      lines.push(pick(COMMENTED_HEADERS), pick(COMMENTED_KVS));
    } else if (roll < 0.9) {
      lines.push("");
    } else {
      lines.push(pick(PROSE), "");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Known limitations: a real key after a commented header, and one commented key path declared twice. */
function hitsAcceptedLimitation(source: string): boolean {
  let realTable = "";
  let commentedTable = "";
  let afterCommentedHeader = false;
  const commentedPaths = new Set<string>();
  for (const line of source.split("\n")) {
    const commentedHeader = /^# \[([^\]]+)\]$/.exec(line);
    const commentedKey = /^# ([\w.]+) = /.exec(line);
    if (commentedHeader !== null) {
      commentedTable = commentedHeader[1] ?? "";
      afterCommentedHeader = true;
    } else if (line.startsWith("[")) {
      realTable = line.slice(1, -1);
      commentedTable = "";
      afterCommentedHeader = false;
    } else if (commentedKey !== null) {
      const path = [realTable, commentedTable, commentedKey[1]].join("|");
      if (commentedPaths.has(path)) return true;
      commentedPaths.add(path);
    } else if (/^[a-z]/.test(line) && afterCommentedHeader) {
      return true;
    }
  }
  return false;
}

function isExampleBody(body: string): boolean {
  const scan = scanTomlDocument(body);
  if ("error" in scan || scan.tokens.length !== 1) return false;
  const kind = scan.tokens[0]?.kind;
  if (kind !== "header" && kind !== "kv") return false;
  try {
    SmolToml.parse(body);
    return true;
  } catch {
    return false;
  }
}

function uncommentToml(source: string): string {
  return source
    .split(/(?<=\n)/)
    .map((line) => {
      const match = /^(\s*)# ?(.*?)(\r?\n)?$/.exec(line);
      if (match === null) return line;
      const [, indent = "", body = "", newline = ""] = match;
      return isExampleBody(body) ? `${indent}${body}${newline}` : line;
    })
    .join("");
}

function uncommentJsonc(text: string): string {
  return text.replace(/^(\s*)\/\/ (?=\s*["{}[\]])/gm, "$1");
}

function strictParse(text: string): { value: unknown; problems: string[] } {
  const problems: string[] = [];
  const stack: Array<Set<string> | null> = [];
  visit(
    text,
    {
      onObjectBegin: () => {
        stack.push(new Set());
      },
      onObjectEnd: () => {
        stack.pop();
      },
      onArrayBegin: () => {
        stack.push(null);
      },
      onArrayEnd: () => {
        stack.pop();
      },
      onObjectProperty: (key, offset) => {
        const keys = stack[stack.length - 1];
        if (keys === undefined || keys === null) return;
        if (keys.has(key)) problems.push(`duplicate key "${key}" at offset ${offset}`);
        keys.add(key);
      },
      onError: (code, offset) => {
        const line = text.slice(0, offset).split("\n").length;
        problems.push(`${printParseErrorCode(code)} on line ${line}`);
      },
    },
    { allowTrailingComma: true, disallowComments: false },
  );
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (error) {
    problems.push(`parseJsonc: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value, problems };
}

function withoutSchema(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema"));
}

function commentedMembers(lines: ReadonlyArray<string>): Array<readonly [number, number]> {
  const members: Array<readonly [number, number]> = [];
  for (let start = 0; start < lines.length; start++) {
    const match = /^(\s*)\/\/ "[^"]+": (.*)$/.exec(lines[start] ?? "");
    if (match === null) continue;
    const [, indent = "", rest = ""] = match;
    let end = start;
    if (/[{[],?$/.test(rest) && !/[}\]],?$/.test(rest)) {
      const close = new RegExp(`^${indent}// [}\\]],?$`);
      while (end < lines.length && !close.test(lines[end] ?? "")) end++;
      if (end === lines.length) return members.concat([[start, -1]]);
    }
    members.push([start, end]);
    start = end;
  }
  return members;
}

function proseComments(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => line.startsWith("# ") && !EXAMPLE_LINE.test(line))
    .map((line) => line.slice(2).trimEnd());
}

function checkCase(source: string): string[] {
  const failures: string[] = [];
  const outcome = Effect.runSync(Effect.result(convertCliConfigTomlToJsonc(source)));
  if (outcome._tag === "Failure") {
    return [`conversion refused: ${outcome.failure.reason}: ${outcome.failure.detail}`];
  }
  const { text } = outcome.success;

  const base = strictParse(text);
  if (base.problems.length > 0) failures.push(`output is not strict JSONC: ${base.problems}`);

  const emitted = text.split("\n").map((line) => line.trim().replace(/^(\/\/\s*)+/, ""));
  const prose = proseComments(source);
  for (const comment of new Set(prose)) {
    const expected = prose.filter((line) => line === comment).length;
    const actual = emitted.filter((line) => line === comment).length;
    if (actual !== expected) {
      failures.push(`comment "${comment}" appears ${actual} times, expected ${expected}`);
    }
  }

  const allJsonc = strictParse(uncommentJsonc(text));
  if (allJsonc.problems.length > 0) {
    failures.push(`uncommenting every example breaks the JSONC: ${allJsonc.problems}`);
  } else {
    const expected = withoutSchema(SmolToml.parse(uncommentToml(source)));
    try {
      expect(withoutSchema(allJsonc.value)).toEqual(expected);
    } catch (error) {
      failures.push(
        `uncommented JSONC differs from uncommented TOML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const lines = text.split("\n");
  for (const [start, end] of commentedMembers(lines)) {
    if (end === -1) {
      failures.push(`commented member on line ${start + 1} has no closing delimiter`);
      continue;
    }
    const doc = lines
      .map((line, index) =>
        index >= start && index <= end ? line.replace(/^(\s*)\/\/ ?/, "$1") : line,
      )
      .join("\n");
    const { problems } = strictParse(doc);
    if (problems.length > 0) {
      failures.push(
        `uncommenting lines ${start + 1}-${end + 1} (${lines[start]?.trim()}): ${problems}`,
      );
    }
  }
  return failures;
}

describe("convertCliConfigTomlToJsonc: seeded property checks", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: conversion keeps comments once, round-trips examples, and uncomments cleanly`, () => {
      const rand = mulberry32(seed);
      let checked = 0;
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const source = generateSource(rand);
        if (hitsAcceptedLimitation(source)) continue;
        try {
          SmolToml.parse(source);
          SmolToml.parse(uncommentToml(source));
        } catch {
          continue;
        }
        checked++;
        expect(checkCase(source), `seed ${seed}, TOML source:\n${source}`).toEqual([]);
      }
      expect(checked).toBeGreaterThan(CASES_PER_SEED / 4);
    });
  }
});
