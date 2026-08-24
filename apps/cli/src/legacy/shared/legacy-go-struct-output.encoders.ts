import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Byte-faithful reproductions of the established `-o yaml` / `-o toml` output for
 * **struct** payloads (CLI-1975) — an output contract raw Go structs were
 * originally passed through `gopkg.in/yaml.v3` and `github.com/BurntSushi/toml` to produce.
 * Neither library reads `json:` tags, so the emitted keys are derived from
 * the original Go **field names**, not the snake_case JSON the Management API returns:
 *
 * - yaml.v3 lowercases the whole field name (`ProjectRef` → `projectref`)
 * and renders nil pointers as explicit `null`.
 * - BurntSushi keeps the PascalCase field name (`ProjectRef`), omits nil
 * pointers entirely, and renders `time.Time` as a native TOML datetime.
 *
 * Because the TypeScript CLI only ever sees the decoded snake_case JSON, each
 * payload family declares a {@link LegacyGoType} spec mirroring the original struct
 * (field order = original declaration order). The two encoders here then reproduce the
 * exact established bytes — including zero-value filling for
 * non-pointer fields, nil-vs-empty slice handling, yaml.v3's scalar quoting
 * heuristics and 4-space indentation algorithm, and BurntSushi's 2-space table
 * indentation and blank-line placement.
 *
 * Everything in this file is pure and Effect-free so it stays unit-testable.
 * The golden bytes asserted in the unit tests were captured from a scratch Go
 * program (BurntSushi toml v1.6.0,
 * yaml.v3 v3.0.1) over the same payloads.
 */

// Go struct specs

export type LegacyGoType =
  | { readonly kind: "string" }
  | { readonly kind: "uuid" }
  | { readonly kind: "bool" }
  | { readonly kind: "int" }
  | { readonly kind: "float"; readonly bits: 32 | 64 }
  /** Go `time.Time` — native TOML datetime, unquoted yaml timestamp. */
  | { readonly kind: "time" }
  /** Go `interface{}` — shape inferred from the JSON value like `encoding/json` decoding. */
  | { readonly kind: "any" }
  | { readonly kind: "ptr"; readonly elem: LegacyGoType }
  /** oapi-codegen `nullable.Nullable[T]` — a `map[bool]T` under the hood. */
  | { readonly kind: "nullable"; readonly elem: LegacyGoType }
  | { readonly kind: "slice"; readonly elem: LegacyGoType }
  | { readonly kind: "map"; readonly value: LegacyGoType }
  | { readonly kind: "struct"; readonly fields: ReadonlyArray<LegacyGoStructField> };

interface LegacyGoStructField {
  /** JSON tag name — the key present in the decoded payload. */
  readonly json: string;
  /** Go field name (PascalCase). */
  readonly go: string;
  readonly type: LegacyGoType;
}

export const legacyGoString: LegacyGoType = { kind: "string" };
export const legacyGoUuid: LegacyGoType = { kind: "uuid" };
export const legacyGoBool: LegacyGoType = { kind: "bool" };
export const legacyGoInt: LegacyGoType = { kind: "int" };
export const legacyGoFloat32: LegacyGoType = { kind: "float", bits: 32 };
export const legacyGoFloat64: LegacyGoType = { kind: "float", bits: 64 };
export const legacyGoTime: LegacyGoType = { kind: "time" };
export const legacyGoAny: LegacyGoType = { kind: "any" };

export function legacyGoPtr(elem: LegacyGoType): LegacyGoType {
  return { kind: "ptr", elem };
}
export function legacyGoNullable(elem: LegacyGoType): LegacyGoType {
  return { kind: "nullable", elem };
}
export function legacyGoSlice(elem: LegacyGoType): LegacyGoType {
  return { kind: "slice", elem };
}
export function legacyGoMap(value: LegacyGoType): LegacyGoType {
  return { kind: "map", value };
}

/**
 * A struct field spec entry: `[jsonName, type]` derives the Go field name
 * mechanically (each snake_case token capitalized: `api_key` → `ApiKey`,
 * matching oapi-codegen's generated names — verified against `types.gen.go`),
 * or `[jsonName, type, goName]` for explicit names.
 */
export type LegacyGoFieldSpec =
  | readonly [json: string, type: LegacyGoType]
  | readonly [json: string, type: LegacyGoType, goName: string];

export function legacyGoStruct(fields: ReadonlyArray<LegacyGoFieldSpec>): LegacyGoType {
  return {
    kind: "struct",
    fields: fields.map(([json, type, goName]) => ({
      json,
      go: goName ?? legacyGoFieldName(json),
      type,
    })),
  };
}

/**
 * The anonymous wrapper struct Go list commands use for TOML output, e.g.
 * `struct{ Branches []api.BranchResponse `toml:"branches"` }` — the `toml:`
 * tag keeps the wrapper key lowercase while the elements keep Go field names.
 *
 * Also models Go's single-key `map[string]any{"providers": items}` wrapper
 * (`sso list`, all formats): a one-field lowercase-keyed struct renders
 * identically to a one-key map in both encoders.
 */
export function legacyGoTomlListWrapper(key: string, elem: LegacyGoType): LegacyGoType {
  return { kind: "struct", fields: [{ json: key, go: key, type: legacyGoSlice(elem) }] };
}

/** `api_key` → `ApiKey`, `dbAllowedCidrs` → `DbAllowedCidrs`. */
export function legacyGoFieldName(jsonName: string): string {
  return jsonName
    .split("_")
    .map((part) => (part.length === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join("");
}

// Normalized Go value tree (decoded JSON + spec → what the Go structs hold)

type GoValue =
  | { readonly k: "nil" }
  | { readonly k: "str"; readonly v: string }
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "int"; readonly v: number }
  | { readonly k: "float"; readonly v: number; readonly bits: 32 | 64 }
  | { readonly k: "time"; readonly v: string }
  | { readonly k: "struct"; readonly entries: ReadonlyArray<readonly [string, GoValue]> }
  | {
      readonly k: "map";
      readonly nil: boolean;
      readonly entries: ReadonlyArray<readonly [string, GoValue]>;
    }
  /** `nullable.Nullable[T]`: nil map, `{false: zero}` (explicit null) or `{true: value}`. */
  | { readonly k: "nullable"; readonly present: boolean | undefined; readonly value?: GoValue }
  | {
      readonly k: "slice";
      readonly nil: boolean;
      readonly items: ReadonlyArray<GoValue>;
      readonly tables: boolean;
    };

const GO_ZERO_TIME = "0001-01-01T00:00:00Z";
const GO_ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroValue(type: LegacyGoType): GoValue {
  switch (type.kind) {
    case "string":
      return { k: "str", v: "" };
    case "uuid":
      return { k: "str", v: GO_ZERO_UUID };
    case "bool":
      return { k: "bool", v: false };
    case "int":
      return { k: "int", v: 0 };
    case "float":
      return { k: "float", v: 0, bits: type.bits };
    case "time":
      return { k: "time", v: GO_ZERO_TIME };
    case "struct":
      return normalize(undefined, type);
    case "ptr":
    case "any":
      return { k: "nil" };
    case "nullable":
      return { k: "nullable", present: undefined };
    case "slice":
      return { k: "slice", nil: true, items: [], tables: elementsAreTables(type.elem, []) };
    case "map":
      return { k: "map", nil: true, entries: [] };
  }
}

function elementsAreTables(elem: LegacyGoType, items: ReadonlyArray<unknown>): boolean {
  switch (elem.kind) {
    case "struct":
    case "map":
    case "nullable":
      return true;
    case "ptr":
    case "slice":
      return elem.kind === "ptr" ? elementsAreTables(elem.elem, items) : false;
    case "any":
      // Like Go's runtime type inspection: JSON objects decode to
      // map[string]interface{} which BurntSushi treats as tables.
      return items.length > 0 && items.every(isRecord);
    default:
      return false;
  }
}

function normalize(value: unknown, type: LegacyGoType): GoValue {
  switch (type.kind) {
    case "string":
      return typeof value === "string" ? { k: "str", v: value } : zeroValue(type);
    case "uuid":
      return typeof value === "string" && value.length > 0
        ? { k: "str", v: value }
        : zeroValue(type);
    case "bool":
      return { k: "bool", v: value === true };
    case "int":
      return typeof value === "number" && Number.isFinite(value)
        ? { k: "int", v: value }
        : zeroValue(type);
    case "float":
      return typeof value === "number" && Number.isFinite(value)
        ? { k: "float", v: value, bits: type.bits }
        : zeroValue(type);
    case "time":
      return typeof value === "string" && value.length > 0
        ? { k: "time", v: normalizeGoTime(value) }
        : zeroValue(type);
    case "ptr":
      return value === undefined || value === null ? { k: "nil" } : normalize(value, type.elem);
    case "nullable":
      // oapi-codegen: absent key → nil map; explicit JSON null → {false: zero};
      // value → {true: value}.
      if (value === undefined) return { k: "nullable", present: undefined };
      if (value === null) return { k: "nullable", present: false, value: zeroValue(type.elem) };
      return { k: "nullable", present: true, value: normalize(value, type.elem) };
    case "slice": {
      if (!Array.isArray(value)) {
        return { k: "slice", nil: true, items: [], tables: elementsAreTables(type.elem, []) };
      }
      return {
        k: "slice",
        nil: false,
        items: value.map((item) => normalize(item, type.elem)),
        tables: elementsAreTables(type.elem, value),
      };
    }
    case "map": {
      if (!isRecord(value)) return { k: "map", nil: true, entries: [] };
      return {
        k: "map",
        nil: false,
        entries: Object.entries(value).map(([key, v]) => [key, normalize(v, type.value)] as const),
      };
    }
    case "struct": {
      const record = isRecord(value) ? value : {};
      return {
        k: "struct",
        entries: type.fields.map(
          (field) => [field.go, normalize(record[field.json], field.type)] as const,
        ),
      };
    }
    case "any":
      return normalizeAny(value);
  }
}

/** Mirror `encoding/json` decoding into `interface{}`. */
function normalizeAny(value: unknown): GoValue {
  if (value === undefined || value === null) return { k: "nil" };
  if (typeof value === "string") return { k: "str", v: value };
  if (typeof value === "boolean") return { k: "bool", v: value };
  if (typeof value === "number") {
    // JSON numbers decode to float64 in Go's interface{} world.
    return { k: "float", v: value, bits: 64 };
  }
  if (Array.isArray(value)) {
    return {
      k: "slice",
      nil: false,
      items: value.map(normalizeAny),
      tables: value.length > 0 && value.every(isRecord),
    };
  }
  if (isRecord(value)) {
    return {
      k: "map",
      nil: false,
      entries: Object.entries(value).map(([key, v]) => [key, normalizeAny(v)] as const),
    };
  }
  return { k: "nil" };
}

/**
 * Render an RFC3339 input the way Go formats a decoded `time.Time` with
 * `time.RFC3339Nano`: the fraction truncated (not rounded) to nanoseconds —
 * `time`'s `parseNanoseconds` keeps at most 9 fractional digits, so
 * `.1234567895` decodes as `.123456789` — then trailing zeros trimmed (the
 * dot is dropped when the fraction is all zeros) and a zero offset rendered
 * as `Z`.
 */
function normalizeGoTime(value: string): string {
  // Go accepts `,` as the fractional separator on decode (`commaOrPeriod`,
  // `time/format.go`; probed: `time.Time.UnmarshalJSON` parses
  // `…00,123Z` and re-marshals it as `…00.123Z`), so both separators
  // normalize to the dot Go emits (review r3684270625).
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([.,]\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return value;
  const [, base, fraction, offset] = match;
  let frac = "";
  if (fraction !== undefined) {
    const digits = fraction.slice(1, 10).replace(/0+$/, "");
    if (digits.length > 0) frac = `.${digits}`;
  }
  const zone = offset === "Z" || offset === "+00:00" || offset === "-00:00" ? "Z" : offset;
  return `${base}${frac}${zone}`;
}

// Go float formatting (strconv.FormatFloat(f, 'g', -1, bits))

/**
 * Shortest round-trip digits for a float32 value (Go marshals via the typed
 * field), matching Ryu as used by `strconv.FormatFloat(f, 'g', -1, 32)`: the
 * fewest significant digits that parse back to the same float32, taking the
 * candidate correctly rounded from the exact binary value — an exact decimal
 * tie goes to the even final digit, where JS `toPrecision` would round half
 * up (verified against Go: 4249.03125 → `4249.0312`, 4249.09375 →
 * `4249.0938`). Returns `<digits>e<±exp>` for {@link legacyGoFormatFloat}.
 */
function shortestFloat32(value: number): string {
  const rounded = Math.fround(value);
  if (rounded === 0) return "0";
  const sign = rounded < 0 ? "-" : "";
  // Exact float32 decomposition: |rounded| = mantissa * 2^exp2.
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, Math.abs(rounded));
  const bits = view.getUint32(0);
  const biased = (bits >>> 23) & 0xff;
  const frac = BigInt(bits & 0x7fffff);
  const mantissa = biased === 0 ? frac : frac | 0x800000n;
  const exp2 = (biased === 0 ? 1 : biased) - 127 - 23;
  // Exact decimal expansion: |rounded| = 0.<digits> * 10^dp (binary fractions
  // terminate in decimal, via m * 2^-k = m * 5^k * 10^-k).
  let digits: string;
  let dp: number;
  if (exp2 >= 0) {
    digits = (mantissa << BigInt(exp2)).toString();
    dp = digits.length;
  } else {
    digits = (mantissa * 5n ** BigInt(-exp2)).toString();
    dp = digits.length + exp2;
  }
  const significant = digits.replace(/0+$/, "");
  // 9 significant digits always round-trip a float32, so the loop exits.
  for (let precision = 1; precision <= significant.length; precision++) {
    const [candidate, candidateDp] = roundDecimalDigits(digits, dp, precision);
    if (
      Math.fround(Number(`${candidate}e${candidateDp - candidate.length}`)) === Math.abs(rounded)
    ) {
      return `${sign}${candidate}e${candidateDp - candidate.length >= 0 ? "+" : ""}${candidateDp - candidate.length}`;
    }
  }
  return `${sign}${significant}e${dp - significant.length >= 0 ? "+" : ""}${dp - significant.length}`;
}

/**
 * Round an exact decimal expansion `0.<digits> * 10^dp` to `precision`
 * significant digits — nearest, with exact halves to the even final digit
 * (Ryu's tie rule) — returning the rounded digits (trailing zeros stripped)
 * and their decimal-point position.
 */
function roundDecimalDigits(
  digits: string,
  dp: number,
  precision: number,
): readonly [digits: string, dp: number] {
  let head = digits.slice(0, precision);
  const rest = digits.slice(precision);
  const restHalf = rest.length > 0 ? "5".padEnd(rest.length, "0") : "";
  const roundUp =
    rest > restHalf ||
    (rest === restHalf && rest !== "" && "13579".includes(head[head.length - 1] as string));
  let candidateDp = dp;
  if (roundUp) {
    head = (BigInt(head) + 1n).toString();
    if (head.length > precision) {
      // 999… carried over into 100…: one more digit before the point.
      candidateDp += 1;
      head = head.slice(0, precision);
    }
  }
  const stripped = head.replace(/0+$/, "");
  return [stripped.length > 0 ? stripped : "0", candidateDp];
}

/**
 * `strconv.FormatFloat(f, 'g', -1, bits)`: shortest digits, switching to
 * scientific notation when the decimal exponent is < -4 or >= 6 (Go uses
 * `eprec = 6` for shortest formatting), with a sign and >= 2 exponent digits.
 */
export function legacyGoFormatFloat(value: number, bits: 32 | 64): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  const repr = bits === 32 ? shortestFloat32(value) : String(value);
  // JS String(-0) drops the sign; Go's FormatFloat keeps it ("-0").
  const negative = repr.startsWith("-") || Object.is(value, -0);
  const unsigned = negative ? repr.slice(1) : repr;
  // Decompose into digits + decimal exponent.
  const expMatch = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(unsigned);
  if (expMatch === null) return repr;
  const intPart = expMatch[1] as string;
  const fracPart = expMatch[2] ?? "";
  const expPart = expMatch[3];
  let digits = intPart + fracPart;
  // decimal-point position (value = 0.digits * 10^dp)
  let dp = intPart.length + (expPart !== undefined ? Number(expPart) : 0);
  if (/^0+$/.test(digits)) return negative ? "-0" : "0";
  // Strip leading zeros (adjusting the decimal position) and trailing zeros.
  while (digits.startsWith("0")) {
    digits = digits.slice(1);
    dp -= 1;
  }
  digits = digits.replace(/0+$/, "");
  const exp = dp - 1;
  const sign = negative ? "-" : "";
  if (exp < -4 || exp >= 6) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expSign = exp < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exp)).padStart(2, "0");
    return `${sign}${mantissa}e${expSign}${expDigits}`;
  }
  if (dp <= 0) {
    return `${sign}0.${"0".repeat(-dp)}${digits}`;
  }
  if (dp >= digits.length) {
    return `${sign}${digits}${"0".repeat(dp - digits.length)}`;
  }
  return `${sign}${digits.slice(0, dp)}.${digits.slice(dp)}`;
}

// YAML encoder (gopkg.in/yaml.v3 v3.0.1 semantics)

/**
 * Encode a decoded payload as the Go CLI's `-o yaml` output for the given Go
 * struct spec. Returns the full document bytes (trailing newline included).
 */
export function encodeLegacyGoYaml(value: unknown, type: LegacyGoType): string {
  return yamlDocument(normalize(value, type));
}

function yamlDocument(root: GoValue): string {
  switch (root.k) {
    case "slice":
      if (root.items.length === 0) return "[]\n";
      return yamlSequence(root.items, 0);
    case "struct":
      if (root.entries.length === 0) return "{}\n";
      return yamlMapping(yamlStructEntries(root.entries), 0);
    case "map": {
      if (root.entries.length === 0) return "{}\n";
      return yamlMapping(yamlMapEntries(root.entries), 0);
    }
    case "nullable":
      if (root.present === undefined) return "{}\n";
      return yamlNullableBlock(root.present, root.value ?? { k: "nil" }, 0);
    default:
      return `${yamlScalar(root)}\n`;
  }
}

/**
 * A populated `nullable.Nullable[T]` is a `map[bool]T`; yaml.v3 renders the
 * bool key plain (`true:` / `false:`), unlike the string keys `"true"` would
 * produce.
 */
function yamlNullableBlock(present: boolean, value: GoValue, indent: number): string {
  const pad = " ".repeat(indent);
  return `${pad}${present ? "true" : "false"}:${yamlValueSuffix(value, indent)}`;
}

/** yaml.v3's indent algorithm: children of a mapping align to the next 4-column stop. */
function yamlNextIndent(indent: number): number {
  return 4 * Math.floor((indent + 4) / 4);
}

function yamlStructEntries(
  entries: ReadonlyArray<readonly [string, GoValue]>,
): ReadonlyArray<readonly [string, GoValue]> {
  // yaml.v3 lowercases Go field names wholesale (no yaml tags on these structs).
  return entries.map(([go, value]) => [go.toLowerCase(), value] as const);
}

function yamlMapEntries(
  entries: ReadonlyArray<readonly [string, GoValue]>,
): ReadonlyArray<readonly [string, GoValue]> {
  return [...entries].sort(([a], [b]) => (yamlKeyLess(a, b) ? -1 : yamlKeyLess(b, a) ? 1 : 0));
}

/**
 * Go string ordering: `sort.Strings` compares UTF-8 bytes and yaml.v3's
 * `keyList.Less` compares runes — both equal Unicode code-point order, which
 * differs from JS `<` (UTF-16 code-unit order) when an astral character meets
 * a high-BMP one (e.g. Go sorts U+E000 before U+1F600, UTF-16 the reverse).
 *
 * Exported for `legacy-go-output.encoders.ts`'s `sortKeysDeep` -
 * `encoding/json`'s map-key sort is the exact same Go byte/code-point
 * order, so `gen bearer-jwt`'s `--payload` custom-claims object (and every
 * other `encodeGoJson`/`encodeGoStructJsonBody` caller) needs this same
 * comparator instead of a second, divergent copy (CLI-1961 Codex review
 * finding: verified against the real binary that `json.Marshal` of a map
 * with a U+E000 key and a U+10000 key emits the U+E000 key FIRST, while
 * plain JS `Object.keys(...).sort()` on the same two keys yields the
 * reverse order).
 */
export function goStringCompare(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ac = a.codePointAt(i) as number;
    const bc = b.codePointAt(i) as number;
    if (ac !== bc) return ac < bc ? -1 : 1;
    i += ac > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * Port of yaml.v3's `keyList.Less` natural string ordering (sorter.go).
 * Digit runs use `unicode.IsDigit` (any Unicode `Nd` digit — probed: Go
 * orders `a3, a9, a10, a٢`, the Arabic-Indic key LAST, because the naive
 * `rune - '0'` arithmetic yields a huge value for non-ASCII digits; review
 * r3685767973). The ASCII-only {@link isDigit} stays for the scalar parser.
 */
function yamlKeyLess(a: string, b: string): boolean {
  const ar = Array.from(a);
  const br = Array.from(b);
  let digits = false;
  for (let i = 0; i < ar.length && i < br.length; i++) {
    const ac = ar[i] as string;
    const bc = br[i] as string;
    if (ac === bc) {
      digits = isSortDigit(ac);
      continue;
    }
    const al = isLetter(ac);
    const bl = isLetter(bc);
    // Go compares runes (`ar[i] < br[i]`), i.e. code points, not UTF-16 units.
    if (al && bl) return (ac.codePointAt(0) as number) < (bc.codePointAt(0) as number);
    if (al || bl) return digits ? al : bl;
    let an = 0n;
    let bn = 0n;
    if (ac === "0" || bc === "0") {
      for (let j = i - 1; j >= 0 && isSortDigit(ar[j] as string); j--) {
        if (ar[j] !== "0") {
          an = 1n;
          bn = 1n;
          break;
        }
      }
    }
    let ai = i;
    let bi = i;
    // Go accumulates into `int64` WITHOUT overflow checks, so 19+-digit runs
    // wrap negative and sort before shorter positive runs (probed:
    // `a10000000000000000000` precedes `a9000000000000000000`;
    // review r3689635556). `BigInt.asIntN(64, …)` reproduces the wrap.
    for (; ai < ar.length && isSortDigit(ar[ai] as string); ai++) {
      an = BigInt.asIntN(64, an * 10n + BigInt(((ar[ai] as string).codePointAt(0) as number) - 48));
    }
    for (; bi < br.length && isSortDigit(br[bi] as string); bi++) {
      bn = BigInt.asIntN(64, bn * 10n + BigInt(((br[bi] as string).codePointAt(0) as number) - 48));
    }
    if (an !== bn) return an < bn;
    if (ai !== bi) return ai < bi;
    return (ac.codePointAt(0) as number) < (bc.codePointAt(0) as number);
  }
  return ar.length < br.length;
}

/** yaml.v3 sorter's `unicode.IsDigit` — any Unicode decimal digit (`Nd`). */
function isSortDigit(c: string): boolean {
  return /\p{Nd}/u.test(c);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isLetter(c: string): boolean {
  return /\p{L}/u.test(c);
}

function yamlMapping(entries: ReadonlyArray<readonly [string, GoValue]>, indent: number): string {
  const pad = " ".repeat(indent);
  let out = "";
  for (const [key, value] of entries) {
    const keyScalar = yamlKeyScalar(key);
    out += `${pad}${keyScalar}:${yamlValueSuffix(value, indent)}`;
  }
  return out;
}

/**
 * Everything after `key:` — either ` <scalar>\n`, a block-literal header plus
 * content lines, or `\n` plus an indented child block.
 */
function yamlValueSuffix(value: GoValue, indent: number): string {
  switch (value.k) {
    case "nil":
      return " null\n";
    case "str": {
      const style = yamlStringStyle(value.v);
      if (style === "literal") return yamlBlockLiteral(value.v, indent);
      return ` ${yamlStringScalar(value.v, style)}\n`;
    }
    case "bool":
    case "int":
    case "float":
    case "time":
      return ` ${yamlScalar(value)}\n`;
    case "slice":
      if (value.items.length === 0) return " []\n";
      return `\n${yamlSequence(value.items, yamlNextIndent(indent))}`;
    case "struct":
      if (value.entries.length === 0) return " {}\n";
      return `\n${yamlMapping(yamlStructEntries(value.entries), yamlNextIndent(indent))}`;
    case "map":
      if (value.entries.length === 0) return " {}\n";
      return `\n${yamlMapping(yamlMapEntries(value.entries), yamlNextIndent(indent))}`;
    case "nullable":
      // nil `map[bool]T` renders as an empty flow mapping; a populated one
      // becomes a nested mapping with a bool key (`true:` / `false:`).
      if (value.present === undefined) return " {}\n";
      return `\n${yamlNullableBlock(
        value.present,
        value.value ?? { k: "nil" },
        yamlNextIndent(indent),
      )}`;
  }
}

function yamlSequence(items: ReadonlyArray<GoValue>, indent: number): string {
  const pad = " ".repeat(indent);
  let out = "";
  for (const item of items) {
    switch (item.k) {
      case "struct":
      case "map": {
        const entries =
          item.k === "struct" ? yamlStructEntries(item.entries) : yamlMapEntries(item.entries);
        if (entries.length === 0) {
          out += `${pad}- {}\n`;
          break;
        }
        // Compact form: the first key rides on the `- ` line; the block keeps
        // a +2 indent (yaml.v3 special-cases indent inside sequence items).
        const block = yamlMapping(entries, indent + 2);
        out += `${pad}- ${block.slice(indent + 2)}`;
        break;
      }
      case "slice":
        if (item.items.length === 0) {
          out += `${pad}- []\n`;
          break;
        }
        out += `${pad}-\n${yamlSequence(item.items, indent + 2)}`;
        break;
      case "nullable":
        if (item.present === undefined) {
          out += `${pad}- {}\n`;
          break;
        }
        out += `${pad}- ${yamlNullableBlock(
          item.present,
          item.value ?? { k: "nil" },
          indent + 2,
        ).slice(indent + 2)}`;
        break;
      case "str": {
        const style = yamlStringStyle(item.v);
        if (style === "literal") {
          out += `${pad}-${yamlBlockLiteral(item.v, indent + 2)}`;
          break;
        }
        out += `${pad}- ${yamlStringScalar(item.v, style)}\n`;
        break;
      }
      default:
        out += `${pad}- ${yamlScalar(item)}\n`;
    }
  }
  return out;
}

function yamlScalar(value: GoValue): string {
  switch (value.k) {
    case "nil":
      return "null";
    case "bool":
      return value.v ? "true" : "false";
    case "int":
      return String(value.v);
    case "float":
      return legacyGoFormatFloat(value.v, value.bits);
    case "time":
      return value.v;
    case "str": {
      const style = yamlStringStyle(value.v);
      // Multi-line strings only reach here as mapping/sequence values, which
      // are handled by yamlValueSuffix; fall back to double quoting.
      return yamlStringScalar(value.v, style === "literal" ? "double" : style);
    }
    default:
      return "";
  }
}

function yamlKeyScalar(key: string): string {
  const style = yamlStringStyle(key);
  return yamlStringScalar(key, style === "literal" ? "double" : style);
}

type YamlStringStyle = "plain" | "single" | "double" | "literal";

/**
 * Mirror of yaml.v3's style selection: `encode.go` requests literal for
 * multi-line strings and double quotes for strings that resolve to a
 * non-string tag; the emitter (`emitterc.go`) downgrades plain to single (or
 * double) based on its scalar analysis.
 */
function yamlStringStyle(s: string): YamlStringStyle {
  if (s.length === 0) return "double";
  if (yamlHasSpecialChars(s)) return "double";
  if (s.includes("\n")) {
    // Block scalars are rejected when a space precedes a line break or the
    // string ends in a space (emitter `block_allowed` analysis).
    if (/ \n/.test(s) || s.endsWith(" ")) return "double";
    return "literal";
  }
  if (s.includes("\t")) return "double";
  if (!yamlResolvesToString(s)) return "double";
  if (yamlPlainDisallowed(s)) return "single";
  return "plain";
}

/**
 * Characters yaml.v3 treats as "special" (not printable) or line breaks other
 * than `\n` — all of these force double-quoted style with escapes. U+2028 and
 * U+2029 are technically YAML line breaks, but every realistic payload
 * containing them round-trips through the double-quoted `\L` / `\P` escapes.
 */
function yamlHasSpecialChars(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (code === 0x09 || code === 0x0a) continue;
    if (!yamlIsPrintable(code)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * libyaml's `is_printable` (yamlprivateh.go) in code-point terms. Notably the
 * byte-oriented original never accepts a 4-byte UTF-8 lead, so every astral
 * character — as well as C0/C1 controls, DEL, surrogates, the U+FEFF BOM, and
 * U+FFFE/U+FFFF — is "not printable" and gets double-quoted escapes.
 */
function yamlIsPrintable(code: number): boolean {
  if (code === 0x0a) return true;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xd7ff) return true;
  return code >= 0xe000 && code <= 0xfffd && code !== 0xfeff;
}

/** Emitter `block_plain_allowed` analysis for single-line printable strings. */
function yamlPlainDisallowed(s: string): boolean {
  if (s.startsWith(" ") || s.endsWith(" ")) return true;
  if (s.startsWith("---") || s.startsWith("...")) return true;
  const first = s[0] as string;
  if ("#,[]{}&*!|>'\"%@`".includes(first)) return true;
  if ((first === "?" || first === ":" || first === "-") && (s.length === 1 || s[1] === " ")) {
    return true;
  }
  // ':' followed by whitespace/end and '#' preceded by whitespace break plain.
  if (/: |:$/.test(s)) return true;
  if (/ #/.test(s)) return true;
  return false;
}

/**
 * Would yaml.v3's `resolve("", s)` produce a non-string tag? Also covers the
 * YAML 1.1 "old bool" and base-60 spellings the encoder force-quotes.
 */
function yamlResolvesToString(s: string): boolean {
  if (YAML_OLD_BOOLS.has(s)) return false;
  if (YAML_RESOLVE_MAP.has(s)) return false;
  if (YAML_BASE60.test(s)) return false;
  const first = s[0] as string;
  if (first === ".") {
    // resolve()'s '.'-hint branch: strconv.ParseFloat — which ERRORS on
    // overflow (±Inf), so an overflowing spelling stays a string and needs
    // no quoting (probed: Go emits `1e999` plain; review r3685767974).
    return !(/^\.\d+(?:[eE][+-]?\d+)?$/.test(s) && Number.isFinite(Number(s)));
  }
  if (first === "+" || first === "-" || isDigit(first)) {
    if (yamlIsTimestamp(s)) return false;
    const plain = s.replaceAll("_", "");
    if (goParseIntBase0(plain)) return false;
    // strconv.ParseFloat overflow (→ ±Inf) is an error in resolve(), so the
    // value resolves as a string and is emitted plain; underflow (1e-999 → 0)
    // succeeds and stays float-tagged, hence quoted (probed both against Go,
    // review r3685767974). `Number` mirrors the accepted shapes here because
    // YAML_STYLE_FLOAT gates the syntax first.
    if (YAML_STYLE_FLOAT.test(plain) && Number.isFinite(Number(plain))) return false;
    return true;
  }
  // 'M'-hint characters (yYnNtTfFoO~) resolve via the exact map only.
  return true;
}

const YAML_OLD_BOOLS = new Set([
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "on",
  "On",
  "ON",
  "off",
  "Off",
  "OFF",
]);

const YAML_RESOLVE_MAP = new Set([
  "true",
  "True",
  "TRUE",
  "false",
  "False",
  "FALSE",
  "~",
  "null",
  "Null",
  "NULL",
  ".nan",
  ".NaN",
  ".NAN",
  ".inf",
  ".Inf",
  ".INF",
  "+.inf",
  "+.Inf",
  "+.INF",
  "-.inf",
  "-.Inf",
  "-.INF",
]);

const YAML_BASE60 = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/;
const YAML_STYLE_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/** `strconv.ParseInt(s, 0, 64)` / `ParseUint` success (underscores pre-stripped). */
function goParseIntBase0(plain: string): boolean {
  let body = plain;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body.startsWith("-");
    body = body.slice(1);
  }
  // Length-gate before BigInt so a pathological megabyte-of-digits value from
  // the API can't trigger quadratic bigint parsing: uint64 needs at most 20
  // decimal / 16 hex / 22 octal / 64 binary significant digits.
  let parsed: bigint;
  if (/^0[bB][01]+$/.test(body)) {
    const digits = body.slice(2).replace(/^0+(?=.)/, "");
    if (digits.length > 64) return false;
    parsed = BigInt(`0b${digits}`);
  } else if (/^0[oO][0-7]+$/.test(body)) {
    const digits = body.slice(2).replace(/^0+(?=.)/, "");
    if (digits.length > 22) return false;
    parsed = BigInt(`0o${digits}`);
  } else if (/^0[xX][0-9a-fA-F]+$/.test(body)) {
    const digits = body.slice(2).replace(/^0+(?=.)/, "");
    if (digits.length > 16) return false;
    parsed = BigInt(`0x${digits}`);
  } else if (/^0[0-7]*$/.test(body)) {
    const digits = body.replace(/^0+(?=.)/, "");
    if (digits.length > 22) return false;
    parsed = digits === "0" ? 0n : BigInt(`0o${digits}`);
  } else if (/^[1-9][0-9]*$/.test(body)) {
    if (body.length > 20) return false;
    parsed = BigInt(body);
  } else {
    return false;
  }
  // resolve() falls back from ParseInt to ParseUint, so the accepted range is
  // [-2^63, 2^64) — anything beyond either bound is not an int.
  if (negative) return parsed <= 9223372036854775808n;
  return parsed < 18446744073709551616n;
}

/**
 * yaml.v3's `parseTimestamp` layouts (resolve.go `allowedTimestampFormats`),
 * which delegates to `time.Parse` — so calendar dates and zone offsets are
 * validated exactly like Go's time package (verified against the Go binary:
 * `2025-02-31` and `2100-02-29` stay plain, `2024-02-29` is a timestamp).
 */
function yamlIsTimestamp(s: string): boolean {
  // Fraction separator is `.` OR `,` — yaml.v3 resolves timestamps through
  // `time.Parse`, which accepts either (`commaOrPeriod`; probed: Go
  // double-quotes the comma form exactly like the dot form,
  // review r3685767963).
  const match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:([Tt ])(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,]\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      s,
    );
  if (match === null) return false;
  const [, yearRaw, monthRaw, dayRaw, separator, hour, minute, second, offset] = match;
  // The space-separated layout has no timezone; T/t layouts require one.
  if (hour !== undefined) {
    if (separator === " " && offset !== undefined) return false;
    if (separator !== " " && offset === undefined) return false;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  }
  // time.Parse's zone-offset range checks (time/format.go): the hour is
  // rejected above 24 and the minute above 60 — `+24:59` and `+00:60` are
  // accepted, `+25:00` and `+23:99` are not (verified against Go 1.26).
  if (offset !== undefined && offset !== "Z") {
    if (Number(offset.slice(1, 3)) > 24 || Number(offset.slice(4, 6)) > 60) return false;
  }
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > goDaysInMonth(Number(yearRaw), month)) return false;
  return true;
}

/** `time.Parse`'s "day out of range" bound (`daysIn`, proleptic Gregorian). */
function goDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function yamlStringScalar(s: string, style: Exclude<YamlStringStyle, "literal">): string {
  switch (style) {
    case "plain":
      return s;
    case "single":
      return `'${s.replaceAll("'", "''")}'`;
    case "double":
      return yamlDoubleQuoted(s);
  }
}

function yamlDoubleQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    switch (code) {
      case 0x00:
        out += "\\0";
        break;
      case 0x07:
        out += "\\a";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0b:
        out += "\\v";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x1b:
        out += "\\e";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x85:
        out += "\\N";
        break;
      case 0x2028:
        out += "\\L";
        break;
      case 0x2029:
        out += "\\P";
        break;
      default:
        // Non-printables escape by rune width like yaml.v3's double-quoted
        // writer: `\xXX`, `\uXXXX`, or `\U00XXXXXX` with uppercase hex.
        if (yamlIsPrintable(code)) {
          out += ch;
        } else if (code <= 0xff) {
          out += `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
        } else if (code <= 0xffff) {
          out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
        } else {
          out += `\\U${code.toString(16).toUpperCase().padStart(8, "0")}`;
        }
    }
  }
  return out + '"';
}

/**
 * `key: |-` block literal: chomping indicator from the trailing newlines, an
 * explicit `4` indentation indicator when the first line starts with a space
 * or is empty, and content indented to the next 4-column stop.
 *
 * Unlike Go's streaming bufio-backed encoder (which can flush partial output
 * before a later error), this builds the whole document in memory — callers
 * emit all-or-nothing, which only differs observably from Go on multi-KB
 * payloads that fail mid-encode.
 */
function yamlBlockLiteral(s: string, indent: number): string {
  const contentIndent = yamlNextIndent(indent);
  const pad = " ".repeat(contentIndent);
  const trailingNewlines = s.length - s.replace(/\n+$/, "").length;
  const chomp = trailingNewlines === 0 ? "-" : trailingNewlines === 1 ? "" : "+";
  const indicator = s.startsWith(" ") || s.startsWith("\n") ? "4" : "";
  const lines = s.split("\n");
  if (s.endsWith("\n")) lines.pop();
  // yaml.v3 merges a leading empty line's break with the header newline
  // (verified empirically: "\nx" → `|4-\n x\n`, "\n\nx" → `|4-\n\n x\n`).
  if (lines[0] === "") lines.shift();
  const body = lines.map((line) => (line.length === 0 ? "" : `${pad}${line}`)).join("\n");
  return ` |${indicator}${chomp}\n${body}\n`;
}

// TOML encoder (github.com/BurntSushi/toml v1.6.0 semantics)

/**
 * Thrown when BurntSushi would refuse the payload: a populated
 * `nullable.Nullable` field (`map[bool]T` has a non-string key type — observed
 * on `snippets list -o toml`) or a `nil` element inside an inline array.
 */
export class LegacyGoTomlEncodeError extends Data.TaggedError("LegacyGoTomlEncodeError")<{
  readonly message: string;
}> {
  static readonly [ErrorActionabilityFingerprintId] = "LegacyGoTomlEncodeError";
  constructor(message = "toml: cannot encode a map with non-string key type") {
    super({ message });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

/**
 * Encode a decoded payload as the Go CLI's `-o toml` output for the given Go
 * struct spec. Returns the full document bytes (BurntSushi emits nothing for
 * an all-nil payload, so the result can be the empty string).
 *
 * Throws {@link LegacyGoTomlEncodeError} when a populated nullable field is
 * present, matching Go's runtime failure.
 *
 * DOCUMENTED BOUND (review r3689784209): on the ERROR path only, Go's stdout
 * bytes can differ. BurntSushi encodes through an internal `bufio.Writer`, so
 * when more than 4 KiB has been generated before a late encode error (e.g. a
 * multi-KB `MetadataXml` scalar followed by a nil array element in a
 * sub-table), Go has already auto-flushed whole 4096-byte chunks to stdout —
 * probed on the repo's own `utils.EncodeOutput`: a 5000-char scalar +
 * `[1, nil]` default leaves EXACTLY 4096 bytes flushed (the buffered tail is
 * lost — NOT the full accumulated prefix), while the same payload under 4 KiB
 * leaves 0 bytes. This all-in-memory port deliberately emits nothing on
 * error: reproducing Go would mean emulating bufio's flush boundaries and
 * large-write bypass over BurntSushi's internal write granularity, for
 * unparseable partial output on a failure path. Do not "fix" this by
 * emitting the accumulated prefix — that emits MORE than Go does.
 */
export function encodeLegacyGoToml(value: unknown, type: LegacyGoType): string {
  const state = { out: "", hasWritten: false };
  tomlEncode(state, [], normalize(value, type));
  return state.out;
}

interface TomlState {
  out: string;
  hasWritten: boolean;
}

function tomlWrite(state: TomlState, text: string): void {
  state.out += text;
  state.hasWritten = true;
}

/** `enc.newline()` — a separator newline suppressed until something is written. */
function tomlNewline(state: TomlState): void {
  if (state.hasWritten) state.out += "\n";
}

function tomlIndent(key: ReadonlyArray<string>): string {
  return "  ".repeat(Math.max(key.length - 1, 0));
}

function tomlIsTable(value: GoValue): boolean {
  switch (value.k) {
    case "struct":
      return true;
    case "map":
      return true;
    case "nullable":
      return true;
    case "slice":
      // Array-of-tables only when non-empty with table elements (BurntSushi's
      // isTableArray returns false for empty slices).
      return value.tables && value.items.length > 0;
    default:
      return false;
  }
}

function tomlIsNil(value: GoValue): boolean {
  switch (value.k) {
    case "nil":
      return true;
    case "slice":
      return value.nil;
    case "map":
      return value.nil;
    case "nullable":
      return value.present === undefined;
    default:
      return false;
  }
}

function tomlEncode(state: TomlState, key: ReadonlyArray<string>, value: GoValue): void {
  if (tomlIsNil(value)) return;
  switch (value.k) {
    case "struct":
    case "map":
      tomlTable(state, key, value);
      return;
    case "nullable":
      // Populated nullable.Nullable[T] is a map[bool]T — BurntSushi panics.
      throw new LegacyGoTomlEncodeError();
    case "slice":
      if (tomlIsTable(value)) {
        tomlArrayOfTables(state, key, value.items);
        return;
      }
      tomlKeyValue(state, key, value);
      return;
    default:
      tomlKeyValue(state, key, value);
  }
}

/**
 * Map/struct entries in BurntSushi's write order: map entries sorted by
 * {@link goStringCompare} (structs keep declaration order), then both
 * partitioned into non-table ("direct") and table ("sub") groups via
 * {@link tomlIsTable} — `eStruct`/`eMap` always write direct fields before
 * sub-tables.
 */
function tomlOrderedEntries(value: Extract<GoValue, { k: "struct" | "map" }>): {
  direct: ReadonlyArray<readonly [string, GoValue]>;
  sub: ReadonlyArray<readonly [string, GoValue]>;
} {
  const entries =
    value.k === "map"
      ? [...value.entries].sort(([a], [b]) => goStringCompare(a, b))
      : value.entries;
  return {
    direct: entries.filter(([, v]) => !tomlIsTable(v)),
    sub: entries.filter(([, v]) => tomlIsTable(v)),
  };
}

function tomlTable(
  state: TomlState,
  key: ReadonlyArray<string>,
  value: Extract<GoValue, { k: "struct" | "map" }>,
): void {
  if (key.length === 1) {
    // Extra newline between top-level tables.
    tomlNewline(state);
  }
  if (key.length > 0) {
    tomlWrite(state, `${tomlIndent(key)}[${key.map(tomlKeyName).join(".")}]\n`);
  }
  const { direct, sub } = tomlOrderedEntries(value);
  for (const [name, v] of direct) {
    if (tomlIsNil(v)) continue;
    tomlEncode(state, [...key, name], v);
  }
  for (const [name, v] of sub) {
    if (tomlIsNil(v)) continue;
    tomlEncode(state, [...key, name], v);
  }
}

function tomlArrayOfTables(
  state: TomlState,
  key: ReadonlyArray<string>,
  items: ReadonlyArray<GoValue>,
): void {
  for (const item of items) {
    if (tomlIsNil(item)) continue;
    tomlNewline(state);
    tomlWrite(state, `${tomlIndent(key)}[[${key.map(tomlKeyName).join(".")}]]\n`);
    if (item.k === "struct" || item.k === "map") {
      const { direct, sub } = tomlOrderedEntries(item);
      for (const [name, v] of [...direct, ...sub]) {
        if (tomlIsNil(v)) continue;
        tomlEncode(state, [...key, name], v);
      }
    } else if (item.k === "nullable") {
      throw new LegacyGoTomlEncodeError();
    }
  }
}

function tomlKeyValue(state: TomlState, key: ReadonlyArray<string>, value: GoValue): void {
  const name = key[key.length - 1] as string;
  tomlWrite(state, `${tomlIndent(key)}${tomlKeyName(name)} = ${tomlElement(value)}\n`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKeyName(name: string): string {
  return TOML_BARE_KEY.test(name) ? name : tomlQuoted(name);
}

function tomlElement(value: GoValue): string {
  switch (value.k) {
    case "str":
      return tomlQuoted(value.v);
    case "bool":
      return value.v ? "true" : "false";
    case "int":
      return String(value.v);
    case "float": {
      const repr = legacyGoFormatFloat(value.v, value.bits);
      // TOML floats must carry a decimal point unless in exponent form.
      return repr.includes(".") || repr.includes("e") ? repr : `${repr}.0`;
    }
    case "time":
      return value.v;
    case "slice":
      return `[${value.items.map(tomlElement).join(", ")}]`;
    case "struct":
    case "map":
      return tomlInlineTable(value);
    case "nullable":
      throw new LegacyGoTomlEncodeError();
    case "nil":
      // BurntSushi's `eElement` rejects nil inline-array elements (verified:
      // `[null, "x"]` fails, while nil *map values* are silently skipped).
      throw new LegacyGoTomlEncodeError("toml: cannot encode array with nil element");
  }
}

/**
 * BurntSushi's inline-table form, used for map/struct elements of arrays that
 * are not arrays-of-tables (e.g. `interface{}` values holding
 * `[{"a":1},"x"]`): `{k = v, ...}` with nil entries skipped and, like block
 * tables, non-table values before table values — map keys byte-sorted within
 * each group (verified: `[{"a":{"b":1},"z":2},"x"]` → `[{z = 2.0, a = {b =
 * 1.0}}, "x"]`).
 *
 * The `", "` separator replicates `eMap`/`eStruct` exactly: it is decided by
 * the entry's *position* — for maps, group index with a trailing comma after
 * the direct group when sub-tables follow; for structs, declaration index —
 * so a skipped nil entry in the final position leaves a dangling `", "`
 * (verified: `[{"10":1,"b":null},false]` → `[{10 = 1.0, }, false]`).
 */
function tomlInlineTable(value: Extract<GoValue, { k: "struct" | "map" }>): string {
  let out = "{";
  if (value.k === "map") {
    const sorted = [...value.entries].sort(([a], [b]) => goStringCompare(a, b));
    const direct = sorted.filter(([, v]) => !tomlIsTable(v));
    const sub = sorted.filter(([, v]) => tomlIsTable(v));
    const writeGroup = (
      group: ReadonlyArray<readonly [string, GoValue]>,
      trailingComma: boolean,
    ): void => {
      for (const [index, [name, v]] of group.entries()) {
        if (tomlIsNil(v)) continue;
        out += `${tomlKeyName(name)} = ${tomlElement(v)}`;
        if (trailingComma || index !== group.length - 1) out += ", ";
      }
    };
    writeGroup(direct, sub.length > 0);
    writeGroup(sub, false);
  } else {
    const fields = value.entries.map(([name, v], index) => [name, v, index] as const);
    const direct = fields.filter(([, v]) => !tomlIsTable(v));
    const sub = fields.filter(([, v]) => tomlIsTable(v));
    for (const [name, v, index] of [...direct, ...sub]) {
      if (tomlIsNil(v)) continue;
      out += `${tomlKeyName(name)} = ${tomlElement(v)}`;
      if (index !== value.entries.length - 1) out += ", ";
    }
  }
  return `${out}}`;
}

/** BurntSushi's `dblQuotedReplacer` escape set. */
function tomlQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}
