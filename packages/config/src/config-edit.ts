import * as SmolToml from "smol-toml";
import type { ConfigFormat } from "./config-format.ts";

/**
 * Format-preserving surgical editor for `supabase/config.{toml,json}` (`supabase config
 * pull`, CLI-2064). Pure and synchronous — no Effect, no filesystem: callers own reading the
 * current file text and writing the returned text back out atomically. See ADR 0023 for the
 * rejected alternatives (regenerating the file from the decoded `CliConfig`, adopting a full
 * TOML-AST dependency) and the rationale for span-splicing plus mandatory re-parse
 * verification instead.
 *
 * Design rules:
 * 1. NEVER return unverified text. Every edited document is re-parsed and deep-compared
 *    against a `deepSet` of the original parse before it's returned; any mismatch — whether
 *    from a scanner misjudgment or a genuinely ambiguous document — surfaces as
 *    `verification_mismatch` rather than silently shipping wrong bytes.
 * 2. Refusals are terminal, not best-effort (`ConfigEditRefusalReason`): a document this
 *    module can't safely edit (duplicate table headers, an array-of-tables or inline table
 *    sitting on the edit's path, an existing `env(...)` literal at the destination, a parse
 *    failure) is reported, never patched around.
 * 3. Every edit either REPLACES an existing declared value's span in place, or INSERTS a new
 *    line/table. This module never deletes or reorders anything the caller didn't ask it to
 *    touch, so untouched comments, spacing, and quoting style survive byte-for-byte. An edit
 *    whose value already matches the destination is a no-op: the source is returned
 *    unchanged rather than reformatted.
 * 4. TOML placement (see `resolveTomlPlacement`'s doc comment): an existing `[a.b]` table
 *    gets the new key appended after its last declared key; a table only reachable through
 *    dotted-key assignment (no explicit header) gets a sibling dotted key next to the
 *    existing one — never a synthesized header over dotted keys; otherwise a brand new
 *    `[a.b]` header is inserted after whichever existing table shares the longest path
 *    prefix, or at EOF if none does. `[remotes.<label>]` is the one hardcoded exception: a
 *    newly created remote block always lands at EOF, preceded by one blank line, with
 *    `project_id` written first.
 * 5. Multi-line arrays are rewritten single-line when their value is replaced — only the
 *    value span changes, never the surrounding key/comment text.
 * 6. Keys/table labels are written bare when they match `/^[A-Za-z0-9_-]+$/`, basic-quoted
 *    otherwise (`remotes."feature/login"`, `"+15551234"`); new string values are always
 *    basic-quoted with proper escaping. This module never introduces literal-quote syntax of
 *    its own — an existing literal string elsewhere in the file is preserved verbatim because
 *    it's simply never touched.
 *
 * `ConfigEditValue` intentionally allows nested-object values (e.g. rewriting an entire
 * `auth.sms.test_otp` map in one call): such an edit is flattened into one leaf edit per
 * scalar/array field before planning, so it composes with every rule above without a special
 * "replace a whole table" code path. Flattening only ever ADDS keys under the object's own
 * path — it merges into an existing table rather than deleting sibling keys the object didn't
 * mention, matching this module's "never delete" invariant.
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

// ---------------------------------------------------------------------------
// Small generic helpers shared by both format arms.
// ---------------------------------------------------------------------------

// Duplicated from `lib/env.ts`'s `ENV_CAPTURE_REGEX` rather than imported: this module is
// restricted to `smol-toml` as its only import (see this file's header comment / ADR 0023),
// so it stays independently embeddable wherever a surgical text edit is needed without
// pulling in this package's wider env-resolution graph.
const ENV_CAPTURE_REGEX = /^env\((.*)\)$/;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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
function deepEqualValue(a: unknown, b: unknown): boolean {
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

/** Applies every edit's `path`/`value` on top of `root`, immutably. This is the expected-value
 * side of mandatory verification, and (for JSON) the mutation itself. */
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

// ---------------------------------------------------------------------------
// Leaf flattening: an object-valued edit becomes one leaf edit per scalar/array field.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Value/key rendering (shared rules: bare-if-safe keys, always-basic-quoted strings,
// always-single-line arrays).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TOML character-level scanner.
//
// Produces top-level tokens in document order: blank lines, whole-line comments, table
// headers (`[a.b]` / `[[a.b]]`), and key-value lines (bare/dotted/quoted key, any value type,
// including multi-line arrays and multi-line strings — both scanned as single opaque spans).
// Never throws: a construct it can't make sense of yields an `{ error }` result instead, which
// the caller reports as `parse_error`.
// ---------------------------------------------------------------------------

interface TomlHeaderToken {
  readonly kind: "header";
  readonly start: number;
  readonly end: number;
  readonly path: ReadonlyArray<string>;
  readonly isArrayOfTables: boolean;
}

interface TomlKeyToken {
  readonly kind: "kv";
  readonly start: number;
  readonly end: number;
  /** Fully qualified: the enclosing table's path plus this key's own (possibly dotted) segments. */
  readonly path: ReadonlyArray<string>;
  readonly tableIndex: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** True when this key's OWN value is an inline table (`{ ... }`) — see `findInlineTableOnPath`. */
  readonly insideInlineTable: boolean;
}

interface TomlBlankToken {
  readonly kind: "blank";
  readonly start: number;
  readonly end: number;
}

interface TomlCommentToken {
  readonly kind: "comment";
  readonly start: number;
  readonly end: number;
}

type TomlToken = TomlHeaderToken | TomlKeyToken | TomlBlankToken | TomlCommentToken;

interface TomlScanResult {
  readonly source: string;
  readonly tokens: ReadonlyArray<TomlToken>;
  readonly headers: ReadonlyArray<TomlHeaderToken>;
  readonly newline: "\n" | "\r\n";
  readonly endsWithNewline: boolean;
}

interface TomlScanError {
  readonly error: string;
}

function charAt(source: string, pos: number): string {
  const ch = source[pos];
  return ch ?? "";
}

function skipInlineWhitespace(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor++;
  }
  return cursor;
}

function skipToEndOfLine(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
    cursor++;
  }
  return cursor;
}

function advancePastNewline(source: string, pos: number): number {
  if (source[pos] === "\r" && source[pos + 1] === "\n") {
    return pos + 2;
  }
  if (source[pos] === "\n" || source[pos] === "\r") {
    return pos + 1;
  }
  return pos;
}

function scanBasicString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === '"') {
      return cursor + 1;
    }
    if (ch === "\n" || ch === "\r") {
      return null;
    }
    cursor++;
  }
  return null;
}

function scanLiteralString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "'") {
      return cursor + 1;
    }
    if (ch === "\n" || ch === "\r") {
      return null;
    }
    cursor++;
  }
  return null;
}

function scanMultilineBasicString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === '"' && source.startsWith('"""', cursor)) {
      cursor += 3;
      let extra = 0;
      while (extra < 2 && source[cursor] === '"') {
        cursor++;
        extra++;
      }
      return cursor;
    }
    cursor++;
  }
  return null;
}

function scanMultilineLiteralString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    if (source[cursor] === "'" && source.startsWith("'''", cursor)) {
      cursor += 3;
      let extra = 0;
      while (extra < 2 && source[cursor] === "'") {
        cursor++;
        extra++;
      }
      return cursor;
    }
    cursor++;
  }
  return null;
}

function scanBareValue(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "#" || ch === "\n" || ch === "\r") {
      break;
    }
    cursor++;
  }
  return cursor;
}

/** Scans a bracketed value (array or inline table), tracking nested strings/brackets so an
 * unrelated `]`/`}`/`#` inside a string never terminates the scan early. `openChar`/`closeChar`
 * select array (`[`/`]`) or inline-table (`{`/`}`) matching; comments (`#...`) are only
 * meaningful — and skippable — inside an array, never an inline table. */
function scanBracketedValue(
  source: string,
  pos: number,
  openChar: string,
  closeChar: string,
  allowComments: boolean,
): number | null {
  let cursor = pos;
  let depth = 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === '"') {
      const next = source.startsWith('"""', cursor)
        ? scanMultilineBasicString(source, cursor + 3)
        : scanBasicString(source, cursor + 1);
      if (next === null) {
        return null;
      }
      cursor = next;
      continue;
    }
    if (ch === "'") {
      const next = source.startsWith("'''", cursor)
        ? scanMultilineLiteralString(source, cursor + 3)
        : scanLiteralString(source, cursor + 1);
      if (next === null) {
        return null;
      }
      cursor = next;
      continue;
    }
    if (allowComments && ch === "#") {
      cursor = advancePastNewline(source, skipToEndOfLine(source, cursor));
      continue;
    }
    if (ch === openChar) {
      depth++;
      cursor++;
      continue;
    }
    if (ch === closeChar) {
      depth--;
      cursor++;
      if (depth === 0) {
        return cursor;
      }
      continue;
    }
    cursor++;
  }
  return null;
}

function scanValue(source: string, start: number): number | null {
  const ch = charAt(source, start);
  if (ch === '"') {
    return source.startsWith('"""', start)
      ? scanMultilineBasicString(source, start + 3)
      : scanBasicString(source, start + 1);
  }
  if (ch === "'") {
    return source.startsWith("'''", start)
      ? scanMultilineLiteralString(source, start + 3)
      : scanLiteralString(source, start + 1);
  }
  if (ch === "[") {
    return scanBracketedValue(source, start + 1, "[", "]", true);
  }
  if (ch === "{") {
    return scanBracketedValue(source, start + 1, "{", "}", false);
  }
  if (ch === "") {
    return null;
  }
  return scanBareValue(source, start);
}

const BARE_KEY_CHAR = /^[A-Za-z0-9_-]$/;

function unescapeBasicString(raw: string): string {
  let result = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      result += ch ?? "";
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\" || next === '"') {
      result += next;
      i++;
    } else if (next === "b") {
      result += "\b";
      i++;
    } else if (next === "f") {
      result += "\f";
      i++;
    } else if (next === "n") {
      result += "\n";
      i++;
    } else if (next === "r") {
      result += "\r";
      i++;
    } else if (next === "t") {
      result += "\t";
      i++;
    } else if (next === "u") {
      result += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (next === "U") {
      result += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, i + 10), 16));
      i += 9;
    } else {
      result += next ?? "";
      i++;
    }
  }
  return result;
}

interface DottedKeyScan {
  readonly segments: ReadonlyArray<string>;
  readonly end: number;
}

/** Parses one or more dot-separated key segments (bare, basic-quoted, or literal-quoted),
 * used for both table headers (`[a."b.c"]`) and key-value lines (`a."b.c" = 1`). Stops as soon
 * as no further `.`-continuation is found; the caller checks for the expected terminator
 * (`]` or `=`) itself. */
function scanDottedKeyPath(source: string, pos: number): DottedKeyScan | null {
  const segments: Array<string> = [];
  let cursor = pos;
  for (;;) {
    cursor = skipInlineWhitespace(source, cursor);
    const ch = charAt(source, cursor);
    if (ch === '"') {
      const strEnd = scanBasicString(source, cursor + 1);
      if (strEnd === null) {
        return null;
      }
      segments.push(unescapeBasicString(source.slice(cursor + 1, strEnd - 1)));
      cursor = strEnd;
    } else if (ch === "'") {
      const strEnd = scanLiteralString(source, cursor + 1);
      if (strEnd === null) {
        return null;
      }
      segments.push(source.slice(cursor + 1, strEnd - 1));
      cursor = strEnd;
    } else if (BARE_KEY_CHAR.test(ch)) {
      let bareEnd = cursor;
      while (BARE_KEY_CHAR.test(charAt(source, bareEnd))) {
        bareEnd++;
      }
      segments.push(source.slice(cursor, bareEnd));
      cursor = bareEnd;
    } else {
      return null;
    }
    const afterSegment = skipInlineWhitespace(source, cursor);
    if (charAt(source, afterSegment) === ".") {
      cursor = afterSegment + 1;
      continue;
    }
    cursor = afterSegment;
    break;
  }
  return { segments, end: cursor };
}

function scanTomlDocument(source: string): TomlScanResult | TomlScanError {
  const tokens: Array<TomlToken> = [];
  const headers: Array<TomlHeaderToken> = [];
  const length = source.length;
  let pos = 0;
  let currentTableIndex = -1;
  let currentTablePath: ReadonlyArray<string> = [];

  while (pos < length) {
    const lineStart = pos;
    const firstNonWhitespace = skipInlineWhitespace(source, pos);
    const ch = charAt(source, firstNonWhitespace);

    if (ch === "" || ch === "\n" || ch === "\r") {
      const end = advancePastNewline(source, firstNonWhitespace);
      tokens.push({ kind: "blank", start: lineStart, end });
      pos = end === firstNonWhitespace ? length : end;
      continue;
    }

    if (ch === "#") {
      const end = advancePastNewline(source, skipToEndOfLine(source, firstNonWhitespace));
      tokens.push({ kind: "comment", start: lineStart, end });
      pos = end;
      continue;
    }

    if (ch === "[") {
      const isArrayOfTables = charAt(source, firstNonWhitespace + 1) === "[";
      const keyStart = firstNonWhitespace + (isArrayOfTables ? 2 : 1);
      const parsedPath = scanDottedKeyPath(source, keyStart);
      if (parsedPath === null || parsedPath.segments.length === 0) {
        return { error: `malformed table header at offset ${lineStart}` };
      }
      let closeCursor = parsedPath.end;
      if (charAt(source, closeCursor) !== "]") {
        return { error: `malformed table header at offset ${lineStart}` };
      }
      closeCursor += 1;
      if (isArrayOfTables) {
        if (charAt(source, closeCursor) !== "]") {
          return { error: `malformed array-of-tables header at offset ${lineStart}` };
        }
        closeCursor += 1;
      }
      const end = advancePastNewline(source, skipToEndOfLine(source, closeCursor));
      const headerToken: TomlHeaderToken = {
        kind: "header",
        start: lineStart,
        end,
        path: parsedPath.segments,
        isArrayOfTables,
      };
      headers.push(headerToken);
      tokens.push(headerToken);
      currentTableIndex = headers.length - 1;
      currentTablePath = parsedPath.segments;
      pos = end;
      continue;
    }

    const parsedKey = scanDottedKeyPath(source, firstNonWhitespace);
    if (parsedKey === null || parsedKey.segments.length === 0) {
      return { error: `malformed key-value line at offset ${lineStart}` };
    }
    const afterKey = skipInlineWhitespace(source, parsedKey.end);
    if (charAt(source, afterKey) !== "=") {
      return { error: `malformed key-value line at offset ${lineStart}` };
    }
    const valueStart = skipInlineWhitespace(source, afterKey + 1);
    const valueEndRaw = scanValue(source, valueStart);
    if (valueEndRaw === null) {
      return { error: `unterminated value at offset ${valueStart}` };
    }
    const end = advancePastNewline(source, skipToEndOfLine(source, valueEndRaw));
    const fullPath = [...currentTablePath, ...parsedKey.segments];
    const rawValueText = source.slice(valueStart, valueEndRaw);
    tokens.push({
      kind: "kv",
      start: lineStart,
      end,
      path: fullPath,
      tableIndex: currentTableIndex,
      valueStart,
      valueEnd: valueEndRaw,
      insideInlineTable: rawValueText.startsWith("{"),
    });
    pos = end;
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return { source, tokens, headers, newline, endsWithNewline: source.endsWith(newline) };
}

// ---------------------------------------------------------------------------
// TOML placement + splicing.
// ---------------------------------------------------------------------------

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

function lastKvEndForTableIndex(
  tokens: ReadonlyArray<TomlToken>,
  tableIndex: number,
): number | undefined {
  let last: number | undefined;
  for (const token of tokens) {
    if (token.kind === "kv" && token.tableIndex === tableIndex) {
      last = token.end;
    }
  }
  return last;
}

function headerEndAt(headers: ReadonlyArray<TomlHeaderToken>, index: number): number {
  const header = headers[index];
  return header === undefined ? 0 : header.end;
}

/**
 * Where a brand new table (one with no existing header at all) is inserted: right after
 * whichever EXISTING table shares the longest path prefix with it (ties broken by file order —
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
      const isRemotesLabelRoot = entry.path.length === 2 && entry.path[0] === "remotes";
      const orderedLeaves = isRemotesLabelRoot
        ? [...entry.leaves].sort((a, b) => {
            const aRank = lastSegmentOf(a.path) === "project_id" ? 0 : 1;
            const bRank = lastSegmentOf(b.path) === "project_id" ? 0 : 1;
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
 * Resolves every leaf edit's placement against the scanned document (see this file's header
 * comment, rule 4, for the placement priority) and returns the full splice list plus which new
 * tables each leaf caused to be created (for `AppliedConfigEdit.createdTables`).
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
      const offset =
        lastKvEndForTableIndex(scan.tokens, tableIndex) ?? headerEndAt(scan.headers, tableIndex);
      pushInsertPiece(insertPieces, offset, {
        needsBlankLineBefore: false,
        text: `${renderKeySegment(lastSegmentOf(leaf.path))} = ${renderLeafValue(leaf.value)}${scan.newline}`,
      });
      continue;
    }

    let dottedSiblingOffset: number | undefined;
    let dottedSiblingEnclosingLength = 0;
    for (const key of keyTokens) {
      if (key.path.length > parent.length && startsWithPath(key.path, parent)) {
        dottedSiblingOffset = key.end;
        dottedSiblingEnclosingLength =
          key.tableIndex === -1 ? 0 : (scan.headers[key.tableIndex]?.path.length ?? 0);
      }
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
    const isRemotesLabelRoot = rootPath.length === 2 && rootPath[0] === "remotes";
    const offset = isRemotesLabelRoot
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
    return refused("parse_error", [], scan.error);
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

// ---------------------------------------------------------------------------
// JSON arm.
// ---------------------------------------------------------------------------

function detectJsonIndent(source: string): string | number {
  const match = /\n([ \t]+)\S/.exec(source);
  if (match === null) {
    return 2;
  }
  const indent = match[1] ?? "";
  return indent.includes("\t") ? "\t" : indent.length;
}

function applyJsonEdits(source: string, edits: ReadonlyArray<ConfigEdit>): ConfigEditOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return refused("parse_error", [], describeError(cause));
  }

  if (allEditsAreNoOps(parsed, edits)) {
    return unchangedOutcome(source, edits);
  }

  for (const edit of edits) {
    if (isEnvReferenceValue(valueAtPath(parsed, edit.path))) {
      return refused(
        "env_reference_target",
        edit.path,
        `${edit.path.join(".")} already holds an env() reference`,
      );
    }
  }

  const indent = detectJsonIndent(source);
  const nextValue = deepSet(parsed, edits);
  const rendered = JSON.stringify(nextValue, null, indent);
  const nextText = source.endsWith("\n") ? `${rendered}\n` : rendered;

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(nextText);
  } catch {
    return refused("verification_mismatch", [], "edited document failed to re-parse");
  }
  if (!deepEqualValue(reparsed, nextValue)) {
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

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function applyConfigEdits(
  source: string,
  format: ConfigFormat,
  edits: ReadonlyArray<ConfigEdit>,
): ConfigEditOutcome {
  return format === "json" ? applyJsonEdits(source, edits) : applyTomlEdits(source, edits);
}
