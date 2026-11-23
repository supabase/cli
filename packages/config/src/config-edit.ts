import {
  applyEdits as applyJsonEditsToText,
  findNodeAtLocation,
  modify,
  parseTree,
  type FormattingOptions,
} from "jsonc-parser";
import * as SmolToml from "smol-toml";
import type { ConfigFormat } from "./config-format.ts";
import { parseJsonc } from "./jsonc.ts";
import {
  scanTomlDocument,
  skipInlineWhitespace,
  type TomlHeaderToken,
  type TomlKeyToken,
  type TomlScanResult,
  type TomlToken,
} from "./toml-scan.ts";

/**
 * Format-preserving surgical editor for `supabase/config.{toml,json,jsonc}`. Pure and synchronous:
 * callers own reading the current file text and writing the returned text back out atomically.
 * Every edited document is re-parsed and deep-compared against the original before being
 * returned; any mismatch refuses rather than shipping wrong bytes. An edit either replaces an
 * existing value's span in place or inserts a new line/table — nothing else is touched, so
 * untouched comments, spacing, and quoting survive byte-for-byte. JSON/JSONC documents are
 * span-edited through `jsonc-parser`'s `modify`, keeping comments and trailing commas. See ADR
 * 0023 for the design rationale and rejected alternatives.
 */

export type ConfigEditValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>
  | { readonly [key: string]: ConfigEditValue };

export interface ConfigEdit {
  readonly path: ReadonlyArray<string>;
  readonly value: ConfigEditValue;
}

export type ConfigEditRefusalReason =
  | "duplicate_table_header"
  | "array_of_tables_on_path"
  | "inline_table_on_path"
  | "env_reference_target"
  | "verification_mismatch"
  | "parse_error";

export interface ConfigEditRefusal {
  readonly reason: ConfigEditRefusalReason;
  readonly path: ReadonlyArray<string>;
  readonly detail: string;
}

export interface AppliedConfigEdit {
  readonly path: ReadonlyArray<string>;
  readonly action: "replaced" | "inserted";
  readonly createdTables: ReadonlyArray<ReadonlyArray<string>>;
}

export type ConfigEditOutcome =
  | {
      readonly kind: "applied";
      readonly text: string;
      readonly applied: ReadonlyArray<AppliedConfigEdit>;
    }
  | { readonly kind: "refused"; readonly refusal: ConfigEditRefusal };

/**
 * The `[remotes.<label>]` placement exception: a newly created remote block always lands at
 * EOF, preceded by one blank line, with `project_id` written first.
 */
const REMOTES_TABLE_NAME = "remotes";
const REMOTE_PROJECT_ID_KEY = "project_id";

/** A `[remotes.<label>]` block root — the one table this module places by a hardcoded rule. */
function isRemotesLabelRoot(path: ReadonlyArray<string>): boolean {
  return path.length === 2 && path[0] === REMOTES_TABLE_NAME;
}

// Duplicated from `lib/env.ts` rather than imported so this module avoids pulling in this
// package's wider env-resolution graph.
const ENV_CAPTURE_REGEX = /^env\((.*)\)$/;

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof SmolToml.TomlDate)
  );
}

function isPlainObjectValue(
  value: ConfigEditValue,
): value is { readonly [key: string]: ConfigEditValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

function pathsEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/** True when `prefix` is a prefix of `path` (inclusive of exact equality). */
function startsWithPath(path: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function commonPrefixLength(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length++;
  }
  return length;
}

function lastSegmentOf(path: ReadonlyArray<string>): string {
  const segment = path[path.length - 1];
  return segment ?? "";
}

function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isDeclaredAtPath(root: unknown, path: ReadonlyArray<string>): boolean {
  let current: unknown = root;
  for (const [index, segment] of path.entries()) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    if (index < path.length - 1) {
      current = current[segment];
    }
  }
  return true;
}

function isEnvReferenceValue(value: unknown): boolean {
  return typeof value === "string" && ENV_CAPTURE_REGEX.test(value);
}

/** Structural equality that special-cases `SmolToml.TomlDate` (compared by its own
 * round-trip-faithful `toISOString()`, since two distinct instances of "the same" TOML
 * date/time are never `===`). Used both for mandatory re-parse verification and for
 * detecting a no-op edit. */
export function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a instanceof SmolToml.TomlDate || b instanceof SmolToml.TomlDate) {
    return (
      a instanceof SmolToml.TomlDate &&
      b instanceof SmolToml.TomlDate &&
      a.toISOString() === b.toISOString()
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqualValue(value, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqualValue(a[key], b[key]))
    );
  }
  return false;
}

function deepSetOne(root: unknown, path: ReadonlyArray<string>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  const rest = path.slice(1);
  const base = isPlainRecord(root) ? root : {};
  const existingChild = Object.hasOwn(base, head) ? base[head] : undefined;
  return { ...base, [head]: deepSetOne(existingChild, rest, value) };
}

/** Applies every edit's `path`/`value` on top of `root`, immutably, replacing the whole
 * destination subtree for an object-valued edit. This is the expected-value side of mandatory
 * verification for both formats. */
function deepSet(root: unknown, edits: ReadonlyArray<ConfigEdit>): unknown {
  return edits.reduce<unknown>(
    (accumulator, edit) => deepSetOne(accumulator, edit.path, edit.value),
    root,
  );
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function refused(
  reason: ConfigEditRefusalReason,
  path: ReadonlyArray<string>,
  detail: string,
): ConfigEditOutcome {
  return { kind: "refused", refusal: { reason, path, detail } };
}

/** True when every edit's value already equals the destination's current (parsed) value —
 * nothing would change, so the caller returns the source untouched rather than reformatting
 * it (JSON) or re-deriving splices that would net out to identical bytes (TOML). */
function allEditsAreNoOps(root: unknown, edits: ReadonlyArray<ConfigEdit>): boolean {
  return edits.every((edit) => deepEqualValue(valueAtPath(root, edit.path), edit.value));
}

function unchangedOutcome(source: string, edits: ReadonlyArray<ConfigEdit>): ConfigEditOutcome {
  return {
    kind: "applied",
    text: source,
    applied: edits.map((edit) => ({ path: edit.path, action: "replaced", createdTables: [] })),
  };
}

type ConfigEditLeafValue = string | number | boolean | ReadonlyArray<string | number | boolean>;

interface LeafEdit {
  readonly originalIndex: number;
  readonly path: ReadonlyArray<string>;
  readonly value: ConfigEditLeafValue;
}

function flattenEdits(edits: ReadonlyArray<ConfigEdit>): ReadonlyArray<LeafEdit> {
  const leaves: Array<LeafEdit> = [];
  const walk = (
    originalIndex: number,
    path: ReadonlyArray<string>,
    value: ConfigEditValue,
  ): void => {
    if (isPlainObjectValue(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(originalIndex, [...path, key], child);
      }
      return;
    }
    leaves.push({ originalIndex, path, value });
  };
  edits.forEach((edit, index) => walk(index, edit.path, edit.value));
  return leaves;
}

const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function renderBasicString(value: string): string {
  let escaped = "";
  for (const ch of value) {
    if (ch === "\\") {
      escaped += "\\\\";
    } else if (ch === '"') {
      escaped += '\\"';
    } else if (ch === "\n") {
      escaped += "\\n";
    } else if (ch === "\r") {
      escaped += "\\r";
    } else if (ch === "\t") {
      escaped += "\\t";
    } else {
      const code = ch.codePointAt(0) ?? 0;
      escaped += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    }
  }
  return `"${escaped}"`;
}

function renderKeySegment(segment: string): string {
  return BARE_KEY_PATTERN.test(segment) ? segment : renderBasicString(segment);
}

function renderKeyPath(path: ReadonlyArray<string>): string {
  return path.map(renderKeySegment).join(".");
}

function renderScalar(value: string | number | boolean): string {
  if (typeof value === "string") {
    return renderBasicString(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

// A plain `Array.isArray` guard doesn't exclude `ReadonlyArray<...>` from the non-array branch
// of `ConfigEditLeafValue` (readonly arrays aren't assignable to the built-in guard's `any[]`
// predicate type), so this needs its own explicit predicate to narrow both branches.
function isLeafArrayValue(
  value: ConfigEditLeafValue,
): value is ReadonlyArray<string | number | boolean> {
  return Array.isArray(value);
}

function renderLeafValue(value: ConfigEditLeafValue): string {
  return isLeafArrayValue(value) ? `[${value.map(renderScalar).join(", ")}]` : renderScalar(value);
}

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function applySplices(source: string, splices: ReadonlyArray<Splice>): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = source;
  for (const splice of ordered) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

function findDuplicateTableHeader(
  headers: ReadonlyArray<TomlHeaderToken>,
): ReadonlyArray<string> | undefined {
  const seen = new Set<string>();
  for (const header of headers) {
    if (header.isArrayOfTables) {
      continue;
    }
    const key = pathKey(header.path);
    if (seen.has(key)) {
      return header.path;
    }
    seen.add(key);
  }
  return undefined;
}

function findArrayOfTablesOnPath(
  headers: ReadonlyArray<TomlHeaderToken>,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  for (let length = 1; length <= path.length; length++) {
    const prefix = path.slice(0, length);
    if (headers.some((header) => header.isArrayOfTables && pathsEqual(header.path, prefix))) {
      return prefix;
    }
  }
  return undefined;
}

function findInlineTableOnPath(
  keyTokens: ReadonlyArray<TomlKeyToken>,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  for (const key of keyTokens) {
    if (key.insideInlineTable && key.path.length < path.length && startsWithPath(path, key.path)) {
      return key.path;
    }
  }
  return undefined;
}

function lastKvTokenForTableIndex(
  tokens: ReadonlyArray<TomlToken>,
  tableIndex: number,
): TomlKeyToken | undefined {
  let last: TomlKeyToken | undefined;
  for (const token of tokens) {
    if (token.kind === "kv" && token.tableIndex === tableIndex) {
      last = token;
    }
  }
  return last;
}

function lastKvEndForTableIndex(
  tokens: ReadonlyArray<TomlToken>,
  tableIndex: number,
): number | undefined {
  return lastKvTokenForTableIndex(tokens, tableIndex)?.end;
}

function headerEndAt(headers: ReadonlyArray<TomlHeaderToken>, index: number): number {
  const header = headers[index];
  return header === undefined ? 0 : header.end;
}

/** The line's own leading run of spaces/tabs, read straight off `source` rather than the
 * token's own fields (no token carries its indentation directly). Used to copy an inserted
 * key's indentation from the sibling line it's inserted after (see `planTomlSplices`'s
 * "insert into an existing table" branch) rather than always writing flush-left. */
function indentOfLineAt(source: string, lineStart: number): string {
  return source.slice(lineStart, skipInlineWhitespace(source, lineStart));
}

/**
 * Where a brand new table (one with no existing header at all) is inserted: right after
 * whichever existing table shares the longest path prefix with it (ties broken by file order —
 * the later one wins), or at EOF when no existing table shares any prefix at all.
 * `[remotes.<label>]` blocks bypass this entirely (see the caller) — they always go to EOF.
 */
function placementOffsetForNewTable(
  scan: TomlScanResult,
  targetPath: ReadonlyArray<string>,
): number {
  let bestIndex = -1;
  let bestLength = 0;
  scan.headers.forEach((header, index) => {
    if (header.isArrayOfTables) {
      return;
    }
    const length = commonPrefixLength(header.path, targetPath);
    if (length > 0 && length >= bestLength) {
      bestLength = length;
      bestIndex = index;
    }
  });
  if (bestIndex === -1) {
    return scan.source.length;
  }
  return lastKvEndForTableIndex(scan.tokens, bestIndex) ?? headerEndAt(scan.headers, bestIndex);
}

interface InsertPiece {
  readonly needsBlankLineBefore: boolean;
  readonly text: string;
}

function pushInsertPiece(
  map: Map<number, Array<InsertPiece>>,
  offset: number,
  piece: InsertPiece,
): void {
  const bucket = map.get(offset);
  if (bucket) {
    bucket.push(piece);
  } else {
    map.set(offset, [piece]);
  }
}

interface MissingTableEntry {
  readonly path: ReadonlyArray<string>;
  readonly leaves: Array<LeafEdit>;
}

/** Renders a cluster of newly created tables (shallow-to-deep order already applied by the
 * caller) as one contiguous block: a blank line between each header (matching this file
 * format's own convention — every table, including nested sub-tables, is blank-line
 * separated), `[remotes.<label>]`'s own direct keys sorted `project_id` first. */
function renderMissingTableCluster(
  entries: ReadonlyArray<MissingTableEntry>,
  newline: string,
): string {
  return entries
    .map((entry, index) => {
      const orderedLeaves = isRemotesLabelRoot(entry.path)
        ? [...entry.leaves].sort((a, b) => {
            const aRank = lastSegmentOf(a.path) === REMOTE_PROJECT_ID_KEY ? 0 : 1;
            const bRank = lastSegmentOf(b.path) === REMOTE_PROJECT_ID_KEY ? 0 : 1;
            return aRank - bRank;
          })
        : entry.leaves;
      const header = `[${renderKeyPath(entry.path)}]${newline}`;
      const body = orderedLeaves
        .map(
          (leaf) =>
            `${renderKeySegment(lastSegmentOf(leaf.path))} = ${renderLeafValue(leaf.value)}${newline}`,
        )
        .join("");
      return (index === 0 ? "" : newline) + header + body;
    })
    .join("");
}

interface TomlPlanResult {
  readonly splices: ReadonlyArray<Splice>;
  readonly createdTablesByLeaf: ReadonlyMap<LeafEdit, ReadonlyArray<ReadonlyArray<string>>>;
}

/**
 * Resolves every leaf edit's placement against the scanned document (see
 * {@link placementOffsetForNewTable} for the priority rule for brand-new tables) and returns the
 * full splice list plus which new tables each leaf caused to be created.
 */
function planTomlSplices(scan: TomlScanResult, leaves: ReadonlyArray<LeafEdit>): TomlPlanResult {
  const keyTokens = scan.tokens.filter((token): token is TomlKeyToken => token.kind === "kv");
  const replaceSplices: Array<Splice> = [];
  const insertPieces = new Map<number, Array<InsertPiece>>();
  const missingByPath = new Map<string, MissingTableEntry>();

  for (const leaf of leaves) {
    const exactKey = keyTokens.find((key) => pathsEqual(key.path, leaf.path));
    if (exactKey) {
      replaceSplices.push({
        start: exactKey.valueStart,
        end: exactKey.valueEnd,
        text: renderLeafValue(leaf.value),
      });
      continue;
    }

    const parent = leaf.path.slice(0, -1);
    const tableIndex = scan.headers.findIndex(
      (header) => !header.isArrayOfTables && pathsEqual(header.path, parent),
    );
    if (tableIndex !== -1) {
      const lastKvToken = lastKvTokenForTableIndex(scan.tokens, tableIndex);
      const offset = lastKvToken?.end ?? headerEndAt(scan.headers, tableIndex);
      // Copy the indentation of the sibling key line this insertion follows (the table's
      // last existing key — the new line goes right after it); an empty table has no such
      // sibling to copy, so it stays flush-left, matching prior behavior for that case.
      const indent =
        lastKvToken === undefined ? "" : indentOfLineAt(scan.source, lastKvToken.start);
      pushInsertPiece(insertPieces, offset, {
        needsBlankLineBefore: false,
        text: `${indent}${renderKeySegment(lastSegmentOf(leaf.path))} = ${renderLeafValue(leaf.value)}${scan.newline}`,
      });
      continue;
    }

    let dottedSiblingOffset: number | undefined;
    let dottedSiblingEnclosingLength = 0;
    for (const key of keyTokens) {
      if (key.path.length <= parent.length || !startsWithPath(key.path, parent)) {
        continue;
      }
      // A dotted-sibling candidate must be declared under an ancestor of `parent` (a table
      // header whose path is a prefix of `parent`, root included) via dotted-key assignment —
      // never a key living inside a genuine descendant table (e.g. `host` in
      // `[auth.email.smtp]` when inserting `auth.email.enable_confirmations`).
      const enclosingTablePath =
        key.tableIndex === -1 ? [] : (scan.headers[key.tableIndex]?.path ?? []);
      if (!startsWithPath(parent, enclosingTablePath)) {
        continue;
      }
      dottedSiblingOffset = key.end;
      dottedSiblingEnclosingLength = enclosingTablePath.length;
    }
    if (dottedSiblingOffset !== undefined) {
      const relative = leaf.path.slice(dottedSiblingEnclosingLength);
      pushInsertPiece(insertPieces, dottedSiblingOffset, {
        needsBlankLineBefore: false,
        text: `${renderKeyPath(relative)} = ${renderLeafValue(leaf.value)}${scan.newline}`,
      });
      continue;
    }

    const key = pathKey(parent);
    const bucket = missingByPath.get(key);
    if (bucket) {
      bucket.leaves.push(leaf);
    } else {
      missingByPath.set(key, { path: parent, leaves: [leaf] });
    }
  }

  const createdTablesByLeaf = new Map<LeafEdit, ReadonlyArray<ReadonlyArray<string>>>();

  function nearestMissingAncestor(path: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
    for (let length = path.length - 1; length >= 1; length--) {
      const candidate = path.slice(0, length);
      if (missingByPath.has(pathKey(candidate))) {
        return candidate;
      }
    }
    return undefined;
  }

  function clusterRootOf(path: ReadonlyArray<string>): ReadonlyArray<string> {
    let current = path;
    for (;;) {
      const ancestor = nearestMissingAncestor(current);
      if (ancestor === undefined) {
        return current;
      }
      current = ancestor;
    }
  }

  const clusters = new Map<string, Array<MissingTableEntry>>();
  for (const entry of missingByPath.values()) {
    const root = clusterRootOf(entry.path);
    const key = pathKey(root);
    const list = clusters.get(key);
    if (list) {
      list.push(entry);
    } else {
      clusters.set(key, [entry]);
    }
  }

  for (const entries of clusters.values()) {
    const ordered = [...entries].sort((a, b) => a.path.length - b.path.length);
    const rootEntry = ordered[0];
    if (rootEntry === undefined) {
      continue;
    }
    const rootPath = rootEntry.path;
    const offset = isRemotesLabelRoot(rootPath)
      ? scan.source.length
      : placementOffsetForNewTable(scan, rootPath);
    const text = renderMissingTableCluster(ordered, scan.newline);
    pushInsertPiece(insertPieces, offset, { needsBlankLineBefore: true, text });

    for (const entry of ordered) {
      const chain = ordered
        .filter((candidate) => startsWithPath(entry.path, candidate.path))
        .map((e) => e.path);
      for (const leaf of entry.leaves) {
        createdTablesByLeaf.set(leaf, chain);
      }
    }
  }

  const splices: Array<Splice> = [...replaceSplices];
  for (const [offset, pieces] of insertPieces) {
    let text = "";
    pieces.forEach((piece, index) => {
      if (index === 0 && offset === scan.source.length && !scan.endsWithNewline) {
        text += scan.newline;
      }
      if (piece.needsBlankLineBefore && (offset > 0 || index > 0)) {
        text += scan.newline;
      }
      text += piece.text;
    });
    splices.push({ start: offset, end: offset, text });
  }

  return { splices, createdTablesByLeaf };
}

function applyTomlEdits(source: string, edits: ReadonlyArray<ConfigEdit>): ConfigEditOutcome {
  const scan = scanTomlDocument(source);
  if ("error" in scan) {
    return refused("parse_error", [], `${scan.error} at offset ${scan.offset}`);
  }

  const duplicate = findDuplicateTableHeader(scan.headers);
  if (duplicate !== undefined) {
    return refused(
      "duplicate_table_header",
      duplicate,
      `[${renderKeyPath(duplicate)}] is declared more than once`,
    );
  }

  let sourceValue: unknown;
  try {
    sourceValue = SmolToml.parse(source);
  } catch (cause) {
    return refused("parse_error", [], describeError(cause));
  }

  if (allEditsAreNoOps(sourceValue, edits)) {
    return unchangedOutcome(source, edits);
  }

  const keyTokens = scan.tokens.filter((token): token is TomlKeyToken => token.kind === "kv");
  const leaves = flattenEdits(edits);

  for (const leaf of leaves) {
    const arrayOfTablesPath = findArrayOfTablesOnPath(scan.headers, leaf.path);
    if (arrayOfTablesPath !== undefined) {
      return refused(
        "array_of_tables_on_path",
        arrayOfTablesPath,
        `[[${renderKeyPath(arrayOfTablesPath)}]] is an array of tables; this editor cannot target a path through it`,
      );
    }
    const inlineTablePath = findInlineTableOnPath(keyTokens, leaf.path);
    if (inlineTablePath !== undefined) {
      return refused(
        "inline_table_on_path",
        inlineTablePath,
        `${renderKeyPath(inlineTablePath)} is an inline table; this editor cannot target a path through it`,
      );
    }
    const exactKey = keyTokens.find((key) => pathsEqual(key.path, leaf.path));
    if (exactKey !== undefined && isEnvReferenceValue(valueAtPath(sourceValue, leaf.path))) {
      return refused(
        "env_reference_target",
        leaf.path,
        `${renderKeyPath(leaf.path)} already holds an env() reference`,
      );
    }
    // A root-level single-segment path with no existing exact key has no table to insert a
    // dotted sibling into and no table header to append after — `planTomlSplices`'s "dotted
    // sibling" branch would otherwise treat every unrelated key in the document as a sibling
    // (an empty path is trivially a prefix of everything) and splice in a keyless ` = value`
    // line that only the mandatory re-parse would catch. Refuse up front instead.
    if (exactKey === undefined && leaf.path.length <= 1) {
      return refused(
        "verification_mismatch",
        leaf.path,
        `${renderKeyPath(leaf.path)} would insert a new root-level key; this editor only supports inserting into an existing or newly created table`,
      );
    }
  }

  const { splices, createdTablesByLeaf } = planTomlSplices(scan, leaves);
  const nextText = applySplices(source, splices);

  let reparsed: unknown;
  try {
    reparsed = SmolToml.parse(nextText);
  } catch {
    return refused("verification_mismatch", [], "edited document failed to re-parse");
  }
  const expected = deepSet(sourceValue, edits);
  if (!deepEqualValue(reparsed, expected)) {
    return refused(
      "verification_mismatch",
      [],
      "edited document does not match the expected structure",
    );
  }

  const applied = edits.map((edit, index) => {
    const action = isDeclaredAtPath(sourceValue, edit.path) ? "replaced" : "inserted";
    const createdTables = new Map<string, ReadonlyArray<string>>();
    for (const leaf of leaves) {
      if (leaf.originalIndex !== index) {
        continue;
      }
      for (const table of createdTablesByLeaf.get(leaf) ?? []) {
        createdTables.set(pathKey(table), table);
      }
    }
    return {
      path: edit.path,
      action,
      createdTables: [...createdTables.values()],
    } satisfies AppliedConfigEdit;
  });

  return { kind: "applied", text: nextText, applied };
}

function detectJsonNewline(source: string): "\n" | "\r\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function detectJsonFormatting(source: string): FormattingOptions {
  const match = /\n([ \t]+)\S/.exec(source);
  const indent = match?.[1] ?? "  ";
  const usesTabs = indent.includes("\t");
  return {
    insertSpaces: !usesTabs,
    tabSize: usesTabs ? 1 : indent.length,
    eol: detectJsonNewline(source),
  };
}

function lineEndAfterTrailer(
  text: string,
  from: number,
): { end: number; hadComma: boolean } | null {
  let pos = from;
  let hadComma = false;
  for (;;) {
    const ch = text[pos];
    if (ch === " " || ch === "\t") {
      pos++;
    } else if (ch === "," && !hadComma) {
      hadComma = true;
      pos++;
    } else if (ch === "/" && text[pos + 1] === "*") {
      const close = text.indexOf("*/", pos + 2);
      if (close === -1 || /[\r\n]/.test(text.slice(pos, close))) {
        return null;
      }
      pos = close + 2;
    } else if (ch === "/" && text[pos + 1] === "/") {
      while (pos < text.length && text[pos] !== "\r" && text[pos] !== "\n") {
        pos++;
      }
    } else if (ch === undefined || ch === "\r" || ch === "\n") {
      return { end: pos, hadComma };
    } else {
      return null;
    }
  }
}

/** `modify` inserts right after the previous value and reformats that line, which moves a
 * same-line trailing comment onto the new key; this appends after the line instead. */
function insertAfterLastProperty(
  text: string,
  leaf: { readonly path: ReadonlyArray<string>; readonly value: unknown },
  formatting: FormattingOptions,
): string | undefined {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (root === undefined) {
    return undefined;
  }
  let depth = leaf.path.length;
  let parent = findNodeAtLocation(root, [...leaf.path]);
  while (parent === undefined && depth > 0) {
    depth--;
    parent = findNodeAtLocation(root, leaf.path.slice(0, depth));
  }
  const prev = parent?.children?.[parent.children.length - 1];
  if (parent?.type !== "object" || depth === leaf.path.length || prev === undefined) {
    return undefined;
  }
  const prevEnd = prev.offset + prev.length;
  const trailer = lineEndAfterTrailer(text, prevEnd);
  if (trailer === null) {
    return undefined;
  }
  const eol = formatting.eol ?? "\n";
  const lineStart = Math.max(text.lastIndexOf("\n", prev.offset), -1) + 1;
  const baseIndent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
  const [key, ...rest] = leaf.path.slice(depth);
  const nested = rest.reduceRight<unknown>((value, segment) => ({ [segment]: value }), leaf.value);
  const indentUnit = formatting.insertSpaces ? " ".repeat(formatting.tabSize ?? 2) : "\t";
  const rendered = JSON.stringify(nested, null, indentUnit).split("\n").join(`${eol}${baseIndent}`);
  const insertion = `${eol}${baseIndent}${JSON.stringify(key)}: ${rendered}${trailer.hadComma ? "," : ""}`;
  return (
    text.slice(0, prevEnd) +
    (trailer.hadComma ? "" : ",") +
    text.slice(prevEnd, trailer.end) +
    insertion +
    text.slice(trailer.end)
  );
}

/** Edits `source` towards `target` with minimal span edits so comments survive; undefined when
 * the result cannot be verified. */
export function updateJsonDocument(source: string, target: unknown): string | undefined {
  try {
    const current = parseJsonc(source);
    if (!isPlainRecord(current) || !isPlainRecord(target)) {
      return undefined;
    }
    const formattingOptions = detectJsonFormatting(source);
    let text = source;
    const sync = (
      path: ReadonlyArray<string>,
      from: Readonly<Record<string, unknown>>,
      to: Readonly<Record<string, unknown>>,
    ): void => {
      for (const key of Object.keys(from)) {
        if (!Object.hasOwn(to, key)) {
          text =
            removeProperty(text, [...path, key]) ??
            applyJsonEditsToText(
              text,
              modify(text, [...path, key], undefined, { formattingOptions }),
            );
        }
      }
      for (const [key, value] of Object.entries(to)) {
        const keyPath = [...path, key];
        const existing = Object.hasOwn(from, key) ? from[key] : undefined;
        if (!Object.hasOwn(from, key)) {
          text =
            insertAfterLastProperty(text, { path: keyPath, value }, formattingOptions) ??
            applyJsonEditsToText(text, modify(text, keyPath, value, { formattingOptions }));
        } else if (isPlainRecord(existing) && isPlainRecord(value)) {
          sync(keyPath, existing, value);
        } else if (!deepEqualValue(existing, value)) {
          text = applyJsonEditsToText(text, modify(text, keyPath, value, { formattingOptions }));
        }
      }
    };
    sync([], current, target);
    return deepEqualValue(parseJsonc(text), target) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** `modify` removes from the end of the previous value, which moves a trailing comment onto the
 * wrong key; this removes the property's own line and keeps the previous key's separator strict. */
function removeProperty(text: string, path: ReadonlyArray<string>): string | undefined {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  const property = root === undefined ? undefined : findNodeAtLocation(root, [...path])?.parent;
  const object = property?.parent;
  if (property?.type !== "property" || object?.type !== "object" || object.children === undefined) {
    return undefined;
  }
  const lineStart = text.lastIndexOf("\n", property.offset - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, property.offset))) {
    return undefined;
  }
  const trailer = lineEndAfterTrailer(text, property.offset + property.length);
  if (trailer === null) {
    return undefined;
  }
  const eolLength = text.startsWith("\r\n", trailer.end) ? 2 : text[trailer.end] === "\n" ? 1 : 0;
  const removed = text.slice(0, lineStart) + text.slice(trailer.end + eolLength);
  const prev = object.children[object.children.length - 2];
  if (
    object.children[object.children.length - 1] !== property ||
    trailer.hadComma ||
    prev === undefined
  ) {
    return removed;
  }
  let commaPos = prev.offset + prev.length;
  while (text[commaPos] === " " || text[commaPos] === "\t") {
    commaPos++;
  }
  return text[commaPos] === ","
    ? removed.slice(0, commaPos) + removed.slice(commaPos + 1)
    : undefined;
}

function applyJsonEdits(source: string, edits: ReadonlyArray<ConfigEdit>): ConfigEditOutcome {
  let parsed: unknown;
  try {
    parsed = parseJsonc(source);
  } catch (cause) {
    return refused("parse_error", [], describeError(cause));
  }

  if (allEditsAreNoOps(parsed, edits)) {
    return unchangedOutcome(source, edits);
  }

  // Flattened to one leaf edit per scalar/array field so an object-valued edit only ever merges
  // the leaves it mentions, never deletes an unmentioned sibling. The env-reference check runs
  // per leaf for the same reason: an object edit's own top-level path is never itself a string.
  const leaves = flattenEdits(edits);

  for (const leaf of leaves) {
    if (isEnvReferenceValue(valueAtPath(parsed, leaf.path))) {
      return refused(
        "env_reference_target",
        leaf.path,
        `${leaf.path.join(".")} already holds an env() reference`,
      );
    }
  }

  const formattingOptions = detectJsonFormatting(source);
  let nextText = source;
  for (const leaf of leaves) {
    try {
      nextText =
        insertAfterLastProperty(nextText, leaf, formattingOptions) ??
        applyJsonEditsToText(
          nextText,
          modify(nextText, [...leaf.path], leaf.value, { formattingOptions }),
        );
    } catch (cause) {
      return refused("verification_mismatch", leaf.path, describeError(cause));
    }
  }

  let reparsed: unknown;
  try {
    reparsed = parseJsonc(nextText);
  } catch {
    return refused("verification_mismatch", [], "edited document failed to re-parse");
  }
  // Verified against `deepSet` (the original, un-flattened `edits`) so a sibling an object-valued
  // edit would silently drop surfaces as a mismatch.
  const expected = deepSet(parsed, edits);
  if (!deepEqualValue(reparsed, expected)) {
    return refused(
      "verification_mismatch",
      [],
      "edited document does not match the expected structure",
    );
  }

  const applied = edits.map((edit): AppliedConfigEdit => ({
    path: edit.path,
    action: isDeclaredAtPath(parsed, edit.path) ? "replaced" : "inserted",
    createdTables: [],
  }));

  return { kind: "applied", text: nextText, applied };
}

export function applyConfigEdits(
  source: string,
  format: ConfigFormat,
  edits: ReadonlyArray<ConfigEdit>,
): ConfigEditOutcome {
  return format === "json" ? applyJsonEdits(source, edits) : applyTomlEdits(source, edits);
}
