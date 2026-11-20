import { describe, expect, test } from "vitest";
import * as SmolToml from "smol-toml";
import { CliConfigConvertError, convertCliConfigTomlToJsonc } from "./config-convert.ts";
import { convertCliConfigJsoncToToml } from "./config-convert-toml.ts";
import { parseJsonc } from "./jsonc.ts";

const SEEDS = [1, 7, 42, 2024];
const CASES_PER_SEED = 300;

const KEYS = [
  "a",
  "port",
  "db_pool",
  "with-dash",
  "123",
  "has space",
  "dotted.key",
  'quo"te',
  "back\\slash",
  "ünï",
  "日本",
  "",
  "tab\tkey",
  "[bracket]",
  "a=b",
  "#hash",
];

const CHARS = [
  "a",
  "Z",
  " ",
  '"',
  "\\",
  "'",
  "é",
  "日",
  "😀",
  "\n",
  "\r",
  "\t",
  "\u0000",
  "\u0001",
  "\u001f",
  "\u007f",
  "\u0080",
  " ",
  "#",
  "=",
  "[",
  "]",
  "env(NAME)",
  "\\u0041",
];

const NUMBERS = [
  0,
  1,
  -1,
  54321,
  2 ** 31,
  1.5,
  -0.25,
  0.1,
  1e21,
  1e-7,
  Number.MAX_SAFE_INTEGER,
  123456.789,
];

type Pick = <T>(items: ReadonlyArray<T>) => T;

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

function generator(rand: () => number) {
  const pick: Pick = (items) => items[Math.floor(rand() * items.length)] as never;
  const string = (): string =>
    Array.from({ length: Math.floor(rand() * 7) }, () => pick(CHARS)).join("");
  const scalar = (): string | number | boolean => {
    const roll = rand();
    return roll < 0.5 ? string() : roll < 0.8 ? pick(NUMBERS) : rand() < 0.5;
  };
  const scalarArray = (): unknown[] => Array.from({ length: Math.floor(rand() * 4) }, scalar);
  const object = (depth: number): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      result[pick(KEYS)] = value(depth);
    }
    return result;
  };
  const value = (depth: number): unknown => {
    const roll = rand();
    if (depth >= 3 || roll < 0.4) return scalar();
    if (roll < 0.55) return scalarArray();
    if (roll < 0.7) {
      return Array.from({ length: 1 + Math.floor(rand() * 3) }, () => object(depth + 1));
    }
    if (roll < 0.75) return [scalar(), object(depth + 1)];
    return object(depth + 1);
  };
  return { object, pick };
}

function jsoncSource(config: unknown, rand: () => number): string {
  const indent = rand() < 0.5 ? 2 : 0;
  const text = JSON.stringify(config, null, indent);
  return rand() < 0.5 ? text.replaceAll("\n", "\r\n") : text;
}

function withNullAt(config: Record<string, unknown>, rand: () => number): unknown {
  const clone = structuredClone(config);
  const slots: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number }> = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      slots.push({ holder: node as Record<string, unknown>, key });
      walk(child);
    }
  };
  walk(clone);
  const slot = slots[Math.floor(rand() * slots.length)];
  if (slot === undefined) return { ...clone, nothing: null };
  (slot.holder as Record<string | number, unknown>)[slot.key] = null;
  return clone;
}

function refusalOf(source: string): CliConfigConvertError {
  try {
    convertCliConfigJsoncToToml(source);
  } catch (error) {
    if (error instanceof CliConfigConvertError) return error;
    throw error;
  }
  throw new Error(`expected a refusal for:\n${source}`);
}

describe("convertCliConfigJsoncToToml: seeded property checks", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: TOML output parses back to the source value and survives TOML to JSONC to TOML`, () => {
      const rand = mulberry32(seed);
      const { object } = generator(rand);
      let reversed = 0;
      const shapes = {
        crlf: false,
        arrayTables: false,
        del: false,
        quotedKey: false,
        subtable: false,
      };
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const config = object(0);
        const source = jsoncSource(config, rand);
        const { text } = convertCliConfigJsoncToToml(source);

        expect(SmolToml.parse(text), `seed ${seed}, JSONC source:\n${source}`).toEqual(config);
        expect(text.endsWith("\n")).toBe(true);
        expect(text.startsWith("#:schema ")).toBe(true);
        const crlf = text.includes("\r\n");
        expect(text.replaceAll("\r\n", "")).not.toContain("\r");
        if (crlf) expect(text.replaceAll("\r\n", "")).not.toContain("\n");
        shapes.crlf ||= crlf;
        shapes.arrayTables ||= text.includes("[[");
        shapes.del ||= text.includes("\\u007f");
        shapes.quotedKey ||= /^\s*"/m.test(text);
        shapes.subtable ||= /^\[\w+\.\w+\]/m.test(text);

        const { text: jsonc } = convertCliConfigTomlToJsonc(text);
        const { $schema: _schema, ...jsoncValue } = parseJsonc(jsonc) as Record<string, unknown>;
        expect(jsoncValue, `seed ${seed}, TOML:\n${text}`).toEqual(config);
        const again = convertCliConfigJsoncToToml(jsonc).text;
        expect(SmolToml.parse(again), `seed ${seed}, JSONC:\n${jsonc}`).toEqual(config);
        reversed++;
      }
      expect(reversed).toBe(CASES_PER_SEED);
      expect(shapes).toEqual({
        crlf: true,
        arrayTables: true,
        del: true,
        quotedKey: true,
        subtable: true,
      });
    });

    test(`seed ${seed}: a null anywhere in a generated document is refused as unsupported_value`, () => {
      const rand = mulberry32(seed);
      const { object } = generator(rand);
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const source = jsoncSource(withNullAt(object(0), rand), rand);
        const error = refusalOf(source);
        expect(error.reason, `seed ${seed}, JSONC source:\n${source}`).toBe("unsupported_value");
        expect(error.detail).toContain("null");
        expect(error.sourceLine).toBeGreaterThanOrEqual(1);
      }
    });
  }
});
