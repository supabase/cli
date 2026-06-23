/**
 * BurntSushi-parity TOML encoder for `supabase config push`.
 *
 * Go serialises each push-subset struct with `github.com/BurntSushi/toml`
 * (`Indent = ""`) and diffs the resulting bytes. This module reproduces that
 * encoder's exact output for the value kinds the push subset uses, driven by an
 * explicit per-service **ordered field descriptor** so field order is data, not
 * incidental.
 *
 * Faithful to `BurntSushi/toml@v1.6.0/encode.go`:
 *   - Struct/table fields are emitted in two passes — non-table fields first,
 *     then table fields — each pass preserving declaration order (`eStruct`).
 *   - Map keys are sorted ascending; non-table values before table values
 *     (`eMap`).
 *   - A blank line precedes a table header **only at depth 1** (`eTable`:
 *     `if len(key) == 1`), and only once anything has been written
 *     (`newline` gates on `hasWritten`).
 *   - `nil` pointers / `nil` slices / `nil` maps are omitted entirely
 *     (`isNil`); `omitempty` additionally omits zero-valued non-pointer fields
 *     (`isEmpty`).
 *   - Integers print without a decimal; strings use `"…"` with the same control
 *     escapes as `dblQuotedReplacer`.
 *
 * We do NOT use smol-toml for serialisation — it normalises/sorts keys and
 * would not match BurntSushi's ordering / omitempty / int formatting.
 *
 * @see apps/cli-go/pkg/config/config.go (`ToTomlBytes`)
 */

type TomlNode =
  | { readonly kind: "bool" }
  | { readonly kind: "int" }
  | { readonly kind: "float" }
  | { readonly kind: "string" }
  /** Inline array, e.g. `["a", "b"]`. */
  | { readonly kind: "array"; readonly elem: TomlNode }
  /** Nested struct → `[key]` table. */
  | { readonly kind: "struct"; readonly fields: ReadonlyArray<TomlField> }
  /** `map[string]value` → table with sorted keys. */
  | { readonly kind: "map"; readonly value: TomlNode }
  /** `map[string]struct{}` → sorted keys as empty sub-tables. */
  | { readonly kind: "set" };

export interface TomlField {
  readonly key: string;
  readonly node: TomlNode;
  /** Mirrors the Go `,omitempty` struct tag (zero-valued fields are dropped). */
  readonly omitempty?: boolean;
}

/** A struct value is a record of field key → value (or `undefined` for nil). */
export type TomlValue =
  | boolean
  | number
  | string
  | ReadonlyArray<TomlValue>
  | { readonly [key: string]: TomlValue | undefined }
  | undefined;

/** Same control-char escapes as BurntSushi's `dblQuotedReplacer`. */
function quoteString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\b") {
      out += "\\b";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\f") {
      out += "\\f";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function isBareKey(segment: string): boolean {
  if (segment.length === 0) return false;
  for (const r of segment) {
    if (!/[A-Za-z0-9_-]/.test(r)) return false;
  }
  return true;
}

/** Quotes a single key segment if it is not a bare key (BurntSushi `maybeQuoted`). */
function maybeQuotedKey(segment: string): string {
  return isBareKey(segment) ? segment : quoteString(segment);
}

/** Joins a dotted key path, quoting segments as needed (BurntSushi `Key.String`). */
function keyString(key: ReadonlyArray<string>): string {
  return key.map((segment) => maybeQuotedKey(segment)).join(".");
}

function isTableNode(node: TomlNode): boolean {
  return node.kind === "struct" || node.kind === "map" || node.kind === "set";
}

/** Mirrors BurntSushi `isEmpty` for the value kinds used by the push subset. */
function isEmptyValue(node: TomlNode, value: TomlValue): boolean {
  switch (node.kind) {
    case "bool":
      return value === false;
    case "int":
    case "float":
      return value === 0;
    case "string":
      return value === "";
    case "array":
      return Array.isArray(value) && value.length === 0;
    case "set":
      return Array.isArray(value) && value.length === 0;
    case "map":
      return typeof value === "object" && value !== null && Object.keys(value).length === 0;
    case "struct":
      return false;
  }
}

class TomlWriter {
  out = "";
  private hasWritten = false;

  write(s: string): void {
    this.out += s;
    this.hasWritten = true;
  }

  newline(): void {
    if (this.hasWritten) {
      this.out += "\n";
    }
  }
}

function eElement(w: TomlWriter, node: TomlNode, value: TomlValue): void {
  switch (node.kind) {
    case "string":
      w.write(quoteString(value as string));
      return;
    case "bool":
      w.write((value as boolean) ? "true" : "false");
      return;
    case "int":
      w.write(String(value as number));
      return;
    case "float": {
      const s = String(value as number);
      w.write(s.includes(".") || s.includes("e") ? s : `${s}.0`);
      return;
    }
    case "array": {
      const arr = value as ReadonlyArray<TomlValue>;
      w.write("[");
      arr.forEach((elem, i) => {
        eElement(w, node.elem, elem);
        if (i !== arr.length - 1) w.write(", ");
      });
      w.write("]");
      return;
    }
    default:
      // Tables never appear as array/inline elements in the push subset.
      throw new Error(`cannot encode table node "${node.kind}" as element`);
  }
}

function writeKeyValue(
  w: TomlWriter,
  key: ReadonlyArray<string>,
  node: TomlNode,
  value: TomlValue,
): void {
  w.write(`${maybeQuotedKey(key[key.length - 1] as string)} = `);
  eElement(w, node, value);
  w.newline();
}

function encode(w: TomlWriter, key: ReadonlyArray<string>, node: TomlNode, value: TomlValue): void {
  if (isTableNode(node)) {
    eTable(w, key, node, value);
  } else {
    writeKeyValue(w, key, node, value);
  }
}

function eTable(w: TomlWriter, key: ReadonlyArray<string>, node: TomlNode, value: TomlValue): void {
  if (key.length === 1) {
    // BurntSushi emits an extra newline before each top-level table.
    w.newline();
  }
  if (key.length > 0) {
    w.write(`[${keyString(key)}]`);
    w.newline();
  }
  if (node.kind === "struct") {
    eStruct(w, key, node, value as { readonly [k: string]: TomlValue | undefined });
  } else if (node.kind === "map" || node.kind === "set") {
    eMap(w, key, node, value);
  }
}

function shouldSkip(node: TomlNode, value: TomlValue, omitempty: boolean | undefined): boolean {
  // isNil after indirection: nil pointer / nil slice / nil map → omitted.
  if (value === undefined || value === null) return true;
  if (omitempty && isEmptyValue(node, value)) return true;
  return false;
}

function eStruct(
  w: TomlWriter,
  key: ReadonlyArray<string>,
  node: { readonly fields: ReadonlyArray<TomlField> },
  value: { readonly [k: string]: TomlValue | undefined },
): void {
  const direct = node.fields.filter((f) => !isTableNode(f.node));
  const sub = node.fields.filter((f) => isTableNode(f.node));
  for (const field of [...direct, ...sub]) {
    const fieldValue = value[field.key];
    if (shouldSkip(field.node, fieldValue, field.omitempty)) continue;
    encode(w, [...key, field.key], field.node, fieldValue);
  }
}

function eMap(
  w: TomlWriter,
  key: ReadonlyArray<string>,
  node: { readonly kind: "map" | "set"; readonly value?: TomlNode },
  value: TomlValue,
): void {
  // `set` → map[string]struct{}: keys provided as a string array, each an
  // empty sub-table. `map` → record of key → value.
  let entries: Array<[string, TomlValue]>;
  let valueNode: TomlNode;
  if (node.kind === "set") {
    const keys = (value as ReadonlyArray<string>) ?? [];
    entries = keys.map((k) => [k, {}] as [string, TomlValue]);
    valueNode = { kind: "struct", fields: [] };
  } else {
    const record = (value as { readonly [k: string]: TomlValue | undefined }) ?? {};
    entries = Object.entries(record).filter(([, v]) => v !== undefined) as Array<
      [string, TomlValue]
    >;
    valueNode = node.value as TomlNode;
  }
  // Sort keys; non-table values before table values (BurntSushi `eMap`).
  const tableValued = isTableNode(valueNode);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const direct = tableValued ? [] : entries;
  const subEntries = tableValued ? entries : [];
  for (const [mapKey, mapValue] of [...direct, ...subEntries]) {
    encode(w, [...key, mapKey], valueNode, mapValue);
  }
}

/**
 * Encodes a push-subset struct value to BurntSushi-parity TOML bytes (as a
 * string). `fields` is the ordered field descriptor; `value` is the matching
 * record of field values.
 */
export function encodeToml(
  fields: ReadonlyArray<TomlField>,
  value: { readonly [k: string]: TomlValue | undefined },
): string {
  const w = new TomlWriter();
  eStruct(w, [], { fields }, value);
  return w.out;
}
