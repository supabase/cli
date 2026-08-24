/**
 * A best-effort parser for the Go struct declarations in
 * `apps/cli-go/pkg/api/types.gen.go`, plus a comparison against the
 * {@link LegacyGoType} specs the `*.go-payload.ts` files hand-declare to
 * mirror them (CLI-1975).
 *
 * Nothing mechanically checked that a spec still matches its Go struct — if
 * `types.gen.go` regenerates (field added/removed/reordered/renamed), a spec
 * could silently desync. This module parses the real struct source and walks
 * it in lockstep with the runtime `LegacyGoType` tree, so drift shows up as a
 * failing test instead of a byte-format bug found in the wild (review
 * kanadgupta, PR #6002).
 *
 * This is intentionally scoped to what the 4 current `*.go-payload.ts` specs
 * need: `oapi-codegen`-generated struct bodies with `json:"..."` tags, plain
 * fields, pointers, slices, `map[string]...`, recursively nested anonymous
 * structs, and single-level type aliases (`type X string`). It is not a
 * general Go parser.
 */

import type { LegacyGoType } from "./legacy-go-struct-output.encoders.ts";

type GoParsedKind =
  | "string"
  | "bool"
  | "int"
  | "float"
  | "time"
  | "uuid"
  | "any"
  | "slice"
  | "map"
  | "struct"
  | "unknown";

export interface GoParsedType {
  readonly pointer: boolean;
  readonly kind: GoParsedKind;
  /** Slice element type, or map value type (Go maps here are always `map[string]V`). */
  readonly elem?: GoParsedType;
  readonly fields?: ReadonlyArray<GoParsedField>;
}

interface GoParsedField extends GoParsedType {
  /** JSON tag name — the key present in the decoded payload. */
  readonly json: string;
  /** Go field name (PascalCase). */
  readonly go: string;
}

/**
 * Parse the body of `type <typeName> struct { ... }` out of `source` (the
 * full text of `types.gen.go`, or a small inline fixture in tests) into a
 * {@link GoParsedType} tree.
 */
export function parseGoStruct(source: string, typeName: string): GoParsedType {
  const body = extractStructBody(source, typeName);
  return { pointer: false, kind: "struct", fields: parseStructFields(body, source) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStructBody(source: string, typeName: string): string {
  const declaration = new RegExp(`type\\s+${escapeRegExp(typeName)}\\s+struct\\s*\\{`).exec(source);
  if (declaration === null) {
    throw new Error(`could not find "type ${typeName} struct {" in source`);
  }
  return extractBalancedBody(source, declaration.index + declaration[0].length);
}

/** Given the index right after an opening `{`, return the text up to (excluding) its matching `}`. */
function extractBalancedBody(text: string, openBraceEnd: number): string {
  let depth = 1;
  let i = openBraceEnd;
  for (; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) {
    throw new Error("unbalanced braces while extracting Go struct body");
  }
  return text.slice(openBraceEnd, i - 1);
}

/**
 * Split a struct body into one chunk of source text per field, keeping a
 * nested anonymous struct's full multi-line text (braces, tags, comments)
 * together with its enclosing field. Blank lines and full-line comments
 * between fields are dropped; comments *inside* a nested struct are kept (and
 * re-filtered when that nested body is parsed recursively).
 */
function splitTopLevelFields(body: string): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let current: Array<string> = [];
  let depth = 0;
  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trim();
    if (depth === 0 && (trimmed === "" || trimmed.startsWith("//"))) {
      continue;
    }
    current.push(rawLine);
    for (const ch of rawLine) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  return chunks;
}

function parseStructFields(body: string, source: string): ReadonlyArray<GoParsedField> {
  return splitTopLevelFields(body).map((chunk) => parseFieldChunk(chunk, source));
}

/** Find the LAST backtick-quoted segment in `text` — the field's own struct tag, textually after any nested field tags. */
function splitTypeTextAndTag(text: string): { readonly typeText: string; readonly tag: string } {
  const tagPattern = /`([^`]*)`/g;
  let last: RegExpExecArray | null = null;
  for (let match = tagPattern.exec(text); match !== null; match = tagPattern.exec(text)) {
    last = match;
  }
  if (last === null) {
    throw new Error(`no struct tag found in field declaration: ${text}`);
  }
  return { typeText: text.slice(0, last.index).trim(), tag: last[1] ?? "" };
}

function parseFieldChunk(chunk: string, source: string): GoParsedField {
  const nameMatch = /^\s*([A-Za-z_]\w*)\s+([\s\S]*)$/.exec(chunk);
  if (nameMatch === null) {
    throw new Error(`could not parse Go field declaration: ${chunk}`);
  }
  const go = nameMatch[1];
  const rest = nameMatch[2];
  if (go === undefined || rest === undefined) {
    throw new Error(`could not parse Go field declaration: ${chunk}`);
  }
  const { typeText, tag } = splitTypeTextAndTag(rest);
  const jsonMatch = /json:"([^",]*)/.exec(tag);
  const json = jsonMatch?.[1] ?? "";
  return { json, go, ...classifyGoType(typeText, source) };
}

function classifyGoType(rawText: string, source: string): GoParsedType {
  let text = rawText.trim();
  let pointer = false;
  if (text.startsWith("*")) {
    pointer = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("[]")) {
    return { pointer, kind: "slice", elem: classifyGoType(text.slice(2), source) };
  }
  if (text.startsWith("map[string]")) {
    return { pointer, kind: "map", elem: classifyGoType(text.slice("map[string]".length), source) };
  }
  if (text === "interface{}") {
    return { pointer, kind: "any" };
  }
  if (/^struct\s*\{/.test(text)) {
    const braceIndex = text.indexOf("{");
    const body = extractBalancedBody(text, braceIndex + 1);
    return { pointer, kind: "struct", fields: parseStructFields(body, source) };
  }
  return { pointer, ...classifyBaseType(text, source, new Set()) };
}

/**
 * Classify a bare Go type identifier: a known primitive, or a `type <Name>
 * <basetype>` alias resolved (recursively, guarded against cycles) from the
 * rest of `source`. Falls back to `"unknown"` rather than throwing — this is
 * a best-effort classifier for the comparison step, not a full Go type
 * checker.
 */
function classifyBaseType(
  text: string,
  source: string,
  seen: ReadonlySet<string>,
): { readonly kind: GoParsedKind } {
  if (text === "string") return { kind: "string" };
  if (text === "bool") return { kind: "bool" };
  if (/^u?int(8|16|32|64)?$/.test(text)) return { kind: "int" };
  if (/^float(32|64)$/.test(text)) return { kind: "float" };
  if (text === "time.Time") return { kind: "time" };
  if (text === "openapi_types.UUID") return { kind: "uuid" };
  if (seen.has(text)) return { kind: "unknown" };

  const aliasMatch = new RegExp(
    `^type\\s+${escapeRegExp(text)}\\s+([A-Za-z_][\\w.]*)\\s*$`,
    "m",
  ).exec(source);
  const basetype = aliasMatch?.[1];
  if (basetype === undefined) return { kind: "unknown" };
  return classifyBaseType(basetype.trim(), source, new Set([...seen, text]));
}

// Comparison: LegacyGoType (runtime spec) <-> GoParsedType (parsed Go source)

export interface GoStructDriftMismatch {
  readonly path: string;
  readonly message: string;
}

/**
 * Walk a {@link LegacyGoType} spec and the parser's {@link GoParsedType} in
 * lockstep, returning every mismatch found (field added/removed/reordered,
 * pointer-ness changed, kind changed) rather than stopping at the first one.
 * An empty array means no drift detected.
 */
export function compareLegacyGoTypeToParsedGoType(
  legacy: LegacyGoType,
  parsed: GoParsedType,
  path = "$",
): ReadonlyArray<GoStructDriftMismatch> {
  const mismatches: Array<GoStructDriftMismatch> = [];
  compareType(legacy, parsed, path, mismatches);
  return mismatches;
}

/** `ptr`/`nullable` both mean "Go pointer" for this comparison (CLI-1975 design doc). */
function unwrapLegacyPointer(type: LegacyGoType): {
  readonly pointer: boolean;
  readonly inner: LegacyGoType;
} {
  if (type.kind === "ptr" || type.kind === "nullable") {
    return { pointer: true, inner: type.elem };
  }
  return { pointer: false, inner: type };
}

function legacyKindToParsedKind(kind: LegacyGoType["kind"]): GoParsedKind | undefined {
  switch (kind) {
    case "string":
    case "bool":
    case "int":
    case "float":
    case "time":
    case "uuid":
    case "any":
    case "slice":
    case "map":
    case "struct":
      return kind;
    case "ptr":
    case "nullable":
      return undefined;
  }
}

function compareType(
  legacy: LegacyGoType,
  parsed: GoParsedType,
  path: string,
  mismatches: Array<GoStructDriftMismatch>,
): void {
  const { pointer: legacyPointer, inner } = unwrapLegacyPointer(legacy);
  if (legacyPointer !== parsed.pointer) {
    mismatches.push({
      path,
      message: `pointer-ness mismatch: spec says pointer=${legacyPointer}, Go source says pointer=${parsed.pointer}`,
    });
  }

  if (parsed.kind === "unknown") {
    mismatches.push({
      path,
      message: `could not classify the Go type at ${path}`,
    });
    return;
  }

  const expectedKind = legacyKindToParsedKind(inner.kind);
  if (expectedKind === undefined) {
    mismatches.push({ path, message: `unexpected doubly-wrapped pointer/nullable at ${path}` });
    return;
  }
  if (expectedKind !== parsed.kind) {
    mismatches.push({
      path,
      message: `kind mismatch: spec says "${expectedKind}", Go source says "${parsed.kind}"`,
    });
    return;
  }

  if (inner.kind === "slice" && parsed.kind === "slice") {
    if (parsed.elem === undefined) {
      mismatches.push({ path, message: "Go source is missing a slice element type" });
      return;
    }
    compareType(inner.elem, parsed.elem, `${path}[]`, mismatches);
  } else if (inner.kind === "map" && parsed.kind === "map") {
    if (parsed.elem === undefined) {
      mismatches.push({ path, message: "Go source is missing a map value type" });
      return;
    }
    compareType(inner.value, parsed.elem, `${path}[]`, mismatches);
  } else if (inner.kind === "struct" && parsed.kind === "struct") {
    compareStructFields(inner.fields, parsed.fields ?? [], path, mismatches);
  }
}

function compareStructFields(
  legacyFields: ReadonlyArray<{ readonly json: string; readonly type: LegacyGoType }>,
  parsedFields: ReadonlyArray<GoParsedField>,
  path: string,
  mismatches: Array<GoStructDriftMismatch>,
): void {
  const legacyKeys = legacyFields.map((field) => field.json);
  const parsedKeys = parsedFields.map((field) => field.json);
  if (legacyKeys.join(",") !== parsedKeys.join(",")) {
    mismatches.push({
      path,
      message: `field set/order mismatch: spec has [${legacyKeys.join(", ")}], Go source has [${parsedKeys.join(", ")}]`,
    });
  }

  const parsedByJson = new Map(parsedFields.map((field) => [field.json, field] as const));
  for (const legacyField of legacyFields) {
    const parsedField = parsedByJson.get(legacyField.json);
    if (parsedField === undefined) {
      mismatches.push({ path, message: `field "${legacyField.json}" removed from Go struct` });
      continue;
    }
    compareType(legacyField.type, parsedField, `${path}.${legacyField.json}`, mismatches);
  }

  const legacyKeySet = new Set(legacyKeys);
  for (const parsedField of parsedFields) {
    if (!legacyKeySet.has(parsedField.json)) {
      mismatches.push({ path, message: `field "${parsedField.json}" added to Go struct` });
    }
  }
}
