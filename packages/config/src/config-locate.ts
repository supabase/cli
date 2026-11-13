import { parseTree, type Node } from "jsonc-parser";
import {
  scanTomlDocument,
  type TomlHeaderToken,
  type TomlKeyToken,
  type TomlScanError,
  type TomlScanResult,
} from "./toml-scan.ts";
import type { ConfigFormat } from "./config-format.ts";

/**
 * A 1-based source span; `endLine` and `endColumn` (exclusive) are absent for an empty span, and
 * `exact` is false when the location is the nearest enclosing ancestor.
 */
export interface CliConfigLocation {
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly exact: boolean;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function lineStarts(text: string): ReadonlyArray<number> {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineIndexOf(starts: ReadonlyArray<number>, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function toLocation(starts: ReadonlyArray<number>, span: Span, exact: boolean): CliConfigLocation {
  const first = lineIndexOf(starts, span.start);
  const last = lineIndexOf(starts, Math.max(span.start, span.end - 1));
  const column = span.start - (starts[first] ?? 0) + 1;
  const end =
    span.end > span.start
      ? { endLine: last + 1, endColumn: span.end - (starts[last] ?? 0) + 1 }
      : {};
  return { line: first + 1, column, ...end, exact };
}

function isScanError(result: TomlScanResult | TomlScanError): result is TomlScanError {
  return "error" in result;
}

const isInlineWhitespace = (character: string | undefined) =>
  character === " " || character === "\t";

function skipInlineWhitespace(source: string, position: number): number {
  let cursor = position;
  while (isInlineWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

function trimEnd(source: string, end: number): number {
  let cursor = end;
  while (cursor > 0 && isInlineWhitespace(source[cursor - 1])) cursor -= 1;
  return cursor;
}

function tomlKeySpan(source: string, token: TomlKeyToken): Span {
  const start = skipInlineWhitespace(source, token.start);
  const equals = source.lastIndexOf("=", token.valueStart - 1);
  return { start, end: trimEnd(source, equals) };
}

function tomlHeaderSpan(source: string, token: TomlHeaderToken): Span {
  const open = skipInlineWhitespace(source, token.start);
  const start = skipInlineWhitespace(source, open + (token.isArrayOfTables ? 2 : 1));
  return { start, end: trimEnd(source, token.keysEnd) };
}

function inlineValueEnd(source: string, start: number, limit: number): number {
  let depth = 0;
  let quote: string | undefined;
  let triple = false;
  for (let index = start; index < limit; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote && (!triple || source.startsWith(quote.repeat(3), index))) {
        if (triple) {
          index += 2;
          for (let extra = 0; extra < 2 && source[index + 1] === quote; extra += 1) index += 1;
        }
        quote = undefined;
        triple = false;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      triple = source.startsWith(character.repeat(3), index);
      if (triple) index += 2;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      if (depth === 0) return trimEnd(source, index);
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return trimEnd(source, index);
    }
  }
  return trimEnd(source, limit);
}

interface InlineEntry {
  readonly keys: ReadonlyArray<string>;
  readonly key: Span;
  readonly value: Span;
}

const isBareKeyCharacter = (character: string | undefined) =>
  character !== undefined && /[A-Za-z0-9_-]/.test(character);

const BASIC_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

function decodeBasicKey(raw: string): string {
  return raw.replace(
    /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g,
    (match, short, long, simple) => {
      const hex = short ?? long;
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return BASIC_ESCAPES[simple] ?? match;
    },
  );
}

function scanKeyPart(
  source: string,
  start: number,
  limit: number,
): { readonly text: string; readonly end: number } | undefined {
  const opener = source[start];
  if (opener === '"' || opener === "'") {
    let cursor = start + 1;
    while (cursor < limit && source[cursor] !== opener) {
      cursor += opener === '"' && source[cursor] === "\\" ? 2 : 1;
    }
    if (cursor >= limit) return undefined;
    const raw = source.slice(start + 1, cursor);
    return { text: opener === '"' ? decodeBasicKey(raw) : raw, end: cursor + 1 };
  }
  let cursor = start;
  while (cursor < limit && isBareKeyCharacter(source[cursor])) cursor += 1;
  return cursor === start ? undefined : { text: source.slice(start, cursor), end: cursor };
}

function inlineTableEntries(source: string, table: Span): ReadonlyArray<InlineEntry> | undefined {
  if (source[table.start] !== "{") return undefined;
  const limit = table.end - 1;
  const entries: Array<InlineEntry> = [];
  let cursor = skipInlineWhitespace(source, table.start + 1);
  while (cursor < limit) {
    const keys: Array<string> = [];
    const keyStart = cursor;
    let keyEnd = cursor;
    for (;;) {
      const part = scanKeyPart(source, cursor, limit);
      if (part === undefined) return undefined;
      keys.push(part.text);
      keyEnd = part.end;
      cursor = skipInlineWhitespace(source, part.end);
      if (source[cursor] !== ".") break;
      cursor = skipInlineWhitespace(source, cursor + 1);
    }
    if (source[cursor] !== "=") return undefined;
    const valueStart = skipInlineWhitespace(source, cursor + 1);
    const valueEnd = inlineValueEnd(source, valueStart, limit);
    entries.push({
      keys,
      key: { start: keyStart, end: keyEnd },
      value: { start: valueStart, end: valueEnd },
    });
    cursor = skipInlineWhitespace(source, valueEnd);
    if (source[cursor] === ",") cursor = skipInlineWhitespace(source, cursor + 1);
  }
  return entries;
}

function locateInInlineTable(
  source: string,
  token: TomlKeyToken,
  rest: ReadonlyArray<string>,
  target: "key" | "value",
): Span | undefined {
  let table: Span = { start: token.valueStart, end: token.valueEnd };
  let remaining = rest;
  while (remaining.length > 0) {
    const entry = inlineTableEntries(source, table)?.find(
      (candidate) =>
        candidate.keys.length <= remaining.length &&
        candidate.keys.every((key, index) => key === remaining[index]),
    );
    if (entry === undefined) return undefined;
    remaining = remaining.slice(entry.keys.length);
    if (remaining.length === 0) return target === "key" ? entry.key : entry.value;
    table = entry.value;
  }
  return undefined;
}

function startsWith(path: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function equals(path: ReadonlyArray<string>, other: ReadonlyArray<string>): boolean {
  return path.length === other.length && startsWith(path, other);
}

interface ScannedToml {
  readonly scan: TomlScanResult | TomlScanError;
  readonly starts: ReadonlyArray<number>;
}

const scanToml = (source: string): ScannedToml => ({
  scan: scanTomlDocument(source),
  starts: lineStarts(source),
});

function indexedTomlPaths(
  scan: TomlScanResult,
): Map<TomlKeyToken | TomlHeaderToken, ReadonlyArray<string>> {
  const entryCounts = new Map<string, number>();
  const indexedPaths = new Map<TomlKeyToken | TomlHeaderToken, ReadonlyArray<string>>();
  const headerPaths: Array<ReadonlyArray<string>> = [];
  const withIndices = (path: ReadonlyArray<string>, upTo: number): Array<string> => {
    const indexed: Array<string> = [];
    for (let length = 1; length <= upTo; length += 1) {
      indexed.push(path[length - 1] as string);
      const count = entryCounts.get(JSON.stringify(path.slice(0, length)));
      if (count !== undefined && length < path.length) indexed.push(String(count - 1));
    }
    return indexed;
  };
  for (const token of scan.tokens) {
    if (token.kind === "header") {
      const key = JSON.stringify(token.path);
      const indexed = withIndices(token.path, token.path.length);
      if (token.isArrayOfTables) {
        const count = entryCounts.get(key) ?? 0;
        indexed.push(String(count));
        entryCounts.set(key, count + 1);
      }
      headerPaths.push(indexed);
      indexedPaths.set(token, indexed);
    } else if (token.kind === "kv") {
      const header = scan.headers[token.tableIndex];
      const tablePath = headerPaths[token.tableIndex];
      indexedPaths.set(
        token,
        header === undefined || tablePath === undefined
          ? token.path
          : [...tablePath, ...token.path.slice(header.path.length)],
      );
    }
  }
  return indexedPaths;
}

function locateToml(
  source: string,
  path: ReadonlyArray<string>,
  target: "key" | "value",
  { scan, starts }: ScannedToml,
): CliConfigLocation | undefined {
  if (isScanError(scan)) return undefined;
  const pathOf = indexedTomlPaths(scan);
  const indexedPath = (token: TomlKeyToken | TomlHeaderToken) => pathOf.get(token) ?? token.path;
  const keys = scan.tokens.filter((token): token is TomlKeyToken => token.kind === "kv");
  const spanOf = (token: TomlKeyToken) =>
    target === "value"
      ? { start: token.valueStart, end: token.valueEnd }
      : tomlKeySpan(source, token);

  for (let length = path.length; length > 0; length -= 1) {
    const wanted = path.slice(0, length);
    const exact = length === path.length;
    const key = keys.find((token) => equals(indexedPath(token), wanted));
    if (key !== undefined) return toLocation(starts, spanOf(key), exact);
    const header = scan.headers.find((token) => equals(indexedPath(token), wanted));
    if (header !== undefined) return toLocation(starts, tomlHeaderSpan(source, header), exact);

    const inline = keys.find(
      (token) =>
        token.insideInlineTable &&
        indexedPath(token).length < length &&
        startsWith(wanted, indexedPath(token)),
    );
    if (inline !== undefined) {
      const span = locateInInlineTable(
        source,
        inline,
        wanted.slice(indexedPath(inline).length),
        target,
      );
      if (span !== undefined) return toLocation(starts, span, exact);
    }

    const descendant = scan.tokens.find(
      (token): token is TomlKeyToken | TomlHeaderToken =>
        (token.kind === "kv" || token.kind === "header") && startsWith(indexedPath(token), wanted),
    );
    if (descendant !== undefined) {
      const span =
        descendant.kind === "kv"
          ? tomlKeySpan(source, descendant)
          : tomlHeaderSpan(source, descendant);
      return toLocation(starts, span, false);
    }
  }
  return undefined;
}

function childOf(node: Node, segment: string): { entry: Node; value: Node } | undefined {
  if (node.type === "array") {
    const value = node.children?.[Number(segment)];
    return value === undefined ? undefined : { entry: value, value };
  }
  if (node.type !== "object") return undefined;
  const entry = node.children?.findLast((property) => property.children?.[0]?.value === segment);
  const value = entry?.children?.[1];
  return entry === undefined || value === undefined ? undefined : { entry, value };
}

interface ScannedJson {
  readonly root: Node | undefined;
  readonly starts: ReadonlyArray<number>;
}

const scanJson = (source: string): ScannedJson => ({
  root: parseTree(source, [], { allowTrailingComma: true, disallowComments: false }),
  starts: lineStarts(source),
});

function locateJson(
  path: ReadonlyArray<string>,
  target: "key" | "value",
  { root, starts }: ScannedJson,
): CliConfigLocation | undefined {
  if (root === undefined) return undefined;

  for (let length = path.length; length > 0; length -= 1) {
    let node: Node | undefined = root;
    let entry: Node | undefined;
    for (const segment of path.slice(0, length)) {
      const child: { entry: Node; value: Node } | undefined =
        node === undefined ? undefined : childOf(node, segment);
      node = child?.value;
      entry = child?.entry;
    }
    if (node === undefined || entry === undefined) continue;
    const picked = target === "key" ? (entry.children?.[0] ?? node) : node;
    return toLocation(
      starts,
      { start: picked.offset, end: picked.offset + picked.length },
      length === path.length,
    );
  }
  return undefined;
}

/** One scan of raw config text, owned by the caller so the text is not retained beyond it. */
export interface CliConfigDocumentScan {
  /**
   * Finds where `path` sits, falling back to the nearest enclosing ancestor (`exact: false`) when
   * the key itself is absent; undefined when the text cannot be scanned.
   */
  readonly locate: (
    path: ReadonlyArray<string>,
    target: "key" | "value",
  ) => CliConfigLocation | undefined;
}

export function scanCliConfigDocument(text: string, format: ConfigFormat): CliConfigDocumentScan {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (format === "toml") {
    const scanned = scanToml(source);
    return {
      locate: (path, target) => locateToml(source, path, target, scanned),
    };
  }
  const scanned = scanJson(source);
  return {
    locate: (path, target) => locateJson(path, target, scanned),
  };
}
