import { Option } from "effect";

/**
 * A bounded, hand-written evaluator for the subset of the csvq SQL dialect that
 * the `inspect report` validation rules use. There is no JS port of csvq
 * (`github.com/mithrandie/csvq`), and neither DuckDB (native addon) nor alasql
 * accepts csvq's dialect, so the report's rule queries are evaluated here.
 *
 * Supported grammar (anything outside it throws `LegacyInspectCsvqError`, which
 * the rule evaluator turns into the rule's STATUS cell, matching Go — a per-rule
 * csvq error becomes the cell rather than failing the command):
 *
 *   SELECT <agg|expr> [AS <ident>]
 *   FROM `<file>.csv` [<alias>]
 *   [WHERE <condition>]
 *   [;]
 *
 *   agg       := LISTAGG '(' colRef ',' string ')'
 *              | COUNT '(' ('*' | colRef) ')'
 *              | (SUM|MIN|MAX|AVG) '(' colRef ')'
 *   condition := or
 *   or        := and (OR and)*
 *   and       := not (AND not)*
 *   not       := NOT not | predicate
 *   predicate := '(' condition ')' | comparison
 *   comparison:= arith ( (op arith) | (IS [NOT] NULL) )?
 *   expr      := concat
 *   concat    := arith ('||' arith)*
 *   arith     := term (('+'|'-') term)*
 *   term      := factor (('*'|'/') factor)*
 *   factor    := number | string | colRef | FLOAT '(' expr ')'
 *              | REPLACE '(' expr ',' string ',' string ')' | '(' expr ')'
 *   colRef    := ident ('.' ident)?    (the alias prefix is ignored — single table)
 *
 * csvq value semantics replicated for parity:
 * - Every CSV cell is a string (csvq reads an empty field as `""`, not NULL); the
 *   only NULL values are *computed* (an aggregate over zero rows, or arithmetic on
 *   a non-numeric operand).
 * - A comparison numerically compares its operands only when **both** convert to a
 *   number under Go's `strconv` rules (no surrounding whitespace, no digit
 *   grouping); otherwise it compares them as strings. This mirrors csvq's type
 *   promotion, including the quirk that a thousands-grouped `to_char` value such as
 *   `" 2,000"` falls back to a string comparison.
 * - WHERE keeps a row only when the condition evaluates to TRUE (three-valued
 *   logic: NULL/false exclude the row).
 */

/** Thrown for grammar or evaluation outside the supported csvq subset. */
export class LegacyInspectCsvqError extends Error {
  override readonly name = "LegacyInspectCsvqError";
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180, the shape Postgres `COPY ... WITH CSV HEADER` emits).
// Every field is a string; quoting only affects escaping, not value identity.
// ---------------------------------------------------------------------------

/** A parsed CSV table: header → column index, plus the data rows as strings. */
export interface LegacyCsvTable {
  readonly columns: ReadonlyMap<string, number>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

function parseCsvRecords(text: string): Array<Array<string>> {
  const records: Array<Array<string>> = [];
  let field = "";
  let row: Array<string> = [];
  let inQuotes = false;
  let started = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      started = true;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      pushField();
      started = true;
    } else if (ch === "\n") {
      // `pushRow` resets `started`, so a trailing `\n` leaves no phantom row.
      pushRow();
    } else if (ch === "\r") {
      // Swallow a bare/`\r\n` CR outside quotes WITHOUT marking the record started,
      // so a stray trailing CR cannot synthesise an empty record at EOF.
    } else {
      field += ch;
      started = true;
    }
  }
  // Flush a trailing record unless the input ended exactly on a row boundary.
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }
  return records;
}

/** Parse CSV bytes/text into a header-indexed table. */
export function legacyParseReportCsv(input: Uint8Array | string): LegacyCsvTable {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return { columns: new Map(), rows: [] };
  }
  const header = records[0]!;
  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    columns.set(name.toLowerCase(), index);
  });
  return { columns, rows: records.slice(1) };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "btick"; readonly v: string }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "op"; readonly v: string }
  | { readonly t: "punct"; readonly v: string }
  | { readonly t: "eof" };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function tokenize(sql: string): Array<Token> {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      tokens.push({ t: "str", v: value });
      continue;
    }
    if (ch === "`") {
      let value = "";
      i++;
      while (i < sql.length && sql[i] !== "`") {
        value += sql[i];
        i++;
      }
      i++; // closing backtick
      tokens.push({ t: "btick", v: value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let raw = "";
      while (i < sql.length && /[0-9.eE+-]/.test(sql[i]!)) {
        // Stop a sign that is not part of an exponent (e.g. `1-2`).
        if ((sql[i] === "+" || sql[i] === "-") && !/[eE]/.test(sql[i - 1] ?? "")) break;
        raw += sql[i];
        i++;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new LegacyInspectCsvqError(`invalid number literal: ${raw}`);
      tokens.push({ t: "num", v: n });
      continue;
    }
    if (IDENT_START.test(ch)) {
      let value = "";
      while (i < sql.length && IDENT_PART.test(sql[i]!)) {
        value += sql[i];
        i++;
      }
      tokens.push({ t: "ident", v: value });
      continue;
    }
    // Multi-char operators first.
    const two = sql.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (two === "||") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (
      ch === "=" ||
      ch === "<" ||
      ch === ">" ||
      ch === "*" ||
      ch === "/" ||
      ch === "+" ||
      ch === "-"
    ) {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === "." || ch === ";") {
      tokens.push({ t: "punct", v: ch });
      i++;
      continue;
    }
    throw new LegacyInspectCsvqError(`unexpected character: ${ch}`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValNode =
  | { readonly k: "num"; readonly n: number }
  | { readonly k: "str"; readonly s: string }
  | { readonly k: "col"; readonly name: string }
  | { readonly k: "binop"; readonly op: string; readonly l: ValNode; readonly r: ValNode }
  | { readonly k: "float"; readonly e: ValNode }
  | {
      readonly k: "replace";
      readonly e: ValNode;
      readonly search: string;
      readonly replacement: string;
    };

type CondNode =
  | { readonly k: "or"; readonly l: CondNode; readonly r: CondNode }
  | { readonly k: "and"; readonly l: CondNode; readonly r: CondNode }
  | { readonly k: "not"; readonly e: CondNode }
  | { readonly k: "cmp"; readonly op: string; readonly l: ValNode; readonly r: ValNode }
  | { readonly k: "isnull"; readonly e: ValNode; readonly negated: boolean };

interface AggNode {
  readonly fn: "LISTAGG" | "COUNT" | "SUM" | "MIN" | "MAX" | "AVG";
  readonly col?: string; // undefined for COUNT(*)
  readonly star?: boolean;
  readonly sep?: string; // LISTAGG separator
}

interface SelectStmt {
  readonly agg?: AggNode;
  readonly expr?: ValNode; // plain (non-aggregate) scalar expression
  readonly table: string;
  readonly where?: CondNode;
}

const AGG_FNS = new Set(["LISTAGG", "COUNT", "SUM", "MIN", "MAX", "AVG"]);

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: ReadonlyArray<Token>) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private isKeyword(word: string): boolean {
    const tok = this.peek();
    return tok.t === "ident" && tok.v.toUpperCase() === word;
  }
  private eatKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectKeyword(word: string): void {
    if (!this.eatKeyword(word)) {
      throw new LegacyInspectCsvqError(`expected ${word}`);
    }
  }
  private expectPunct(sym: string): void {
    const tok = this.next();
    if (tok.t !== "punct" || tok.v !== sym) {
      throw new LegacyInspectCsvqError(`expected '${sym}'`);
    }
  }
  private isPunct(sym: string): boolean {
    const tok = this.peek();
    return tok.t === "punct" && tok.v === sym;
  }

  parse(): SelectStmt {
    this.expectKeyword("SELECT");
    const { agg, expr } = this.parseSelectExpr();
    // optional `AS <ident>`
    if (this.eatKeyword("AS")) {
      const tok = this.next();
      if (tok.t !== "ident") throw new LegacyInspectCsvqError("expected alias after AS");
    }
    this.expectKeyword("FROM");
    const tableTok = this.next();
    if (tableTok.t !== "btick") {
      throw new LegacyInspectCsvqError("expected a backtick-quoted CSV table name");
    }
    // optional table alias (a bare ident that is not a clause keyword)
    if (this.peek().t === "ident" && !this.isKeyword("WHERE")) {
      this.pos++;
    }
    let where: CondNode | undefined;
    if (this.eatKeyword("WHERE")) {
      where = this.parseCondition();
    }
    if (this.isPunct(";")) this.pos++;
    if (this.peek().t !== "eof") {
      throw new LegacyInspectCsvqError("unexpected trailing tokens");
    }
    return { agg, expr, table: tableTok.v, where };
  }

  private parseSelectExpr(): { agg?: AggNode; expr?: ValNode } {
    const tok = this.peek();
    if (
      tok.t === "ident" &&
      AGG_FNS.has(tok.v.toUpperCase()) &&
      this.tokens[this.pos + 1]?.t === "punct" &&
      (this.tokens[this.pos + 1] as { v: string }).v === "("
    ) {
      return { agg: this.parseAgg() };
    }
    return { expr: this.parseValueExpr() };
  }

  private parseAgg(): AggNode {
    const fnTok = this.next();
    const fn = (fnTok as { v: string }).v.toUpperCase() as AggNode["fn"];
    this.expectPunct("(");
    if (fn === "COUNT" && this.peek().t === "op" && (this.peek() as { v: string }).v === "*") {
      this.pos++;
      this.expectPunct(")");
      return { fn, star: true };
    }
    const col = this.parseColRef();
    if (fn === "LISTAGG") {
      this.expectPunct(",");
      const sepTok = this.next();
      if (sepTok.t !== "str")
        throw new LegacyInspectCsvqError("LISTAGG separator must be a string");
      this.expectPunct(")");
      return { fn, col, sep: sepTok.v };
    }
    this.expectPunct(")");
    return { fn, col };
  }

  private parseColRef(): string {
    const tok = this.next();
    if (tok.t !== "ident") throw new LegacyInspectCsvqError("expected a column reference");
    if (this.isPunct(".")) {
      this.pos++;
      const col = this.next();
      if (col.t !== "ident") throw new LegacyInspectCsvqError("expected column after '.'");
      return col.v; // alias prefix ignored (single table)
    }
    return tok.v;
  }

  private parseCondition(): CondNode {
    return this.parseOr();
  }
  private parseOr(): CondNode {
    let left = this.parseAnd();
    while (this.eatKeyword("OR")) {
      left = { k: "or", l: left, r: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): CondNode {
    let left = this.parseNot();
    while (this.eatKeyword("AND")) {
      left = { k: "and", l: left, r: this.parseNot() };
    }
    return left;
  }
  private parseNot(): CondNode {
    if (this.eatKeyword("NOT")) {
      return { k: "not", e: this.parseNot() };
    }
    return this.parsePredicate();
  }
  private parsePredicate(): CondNode {
    if (this.isPunct("(")) {
      this.pos++;
      const cond = this.parseCondition();
      this.expectPunct(")");
      return cond;
    }
    const left = this.parseValueExpr();
    if (this.eatKeyword("IS")) {
      const negated = this.eatKeyword("NOT");
      this.expectKeyword("NULL");
      return { k: "isnull", e: left, negated };
    }
    const opTok = this.peek();
    if (opTok.t === "op" && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(opTok.v)) {
      this.pos++;
      const right = this.parseValueExpr();
      return { k: "cmp", op: opTok.v, l: left, r: right };
    }
    throw new LegacyInspectCsvqError("expected a comparison operator");
  }

  private parseValueExpr(): ValNode {
    return this.parseConcat();
  }
  private parseConcat(): ValNode {
    let left = this.parseArith();
    while (this.peek().t === "op" && (this.peek() as { v: string }).v === "||") {
      const op = (this.next() as { v: string }).v;
      left = { k: "binop", op, l: left, r: this.parseArith() };
    }
    return left;
  }
  private parseArith(): ValNode {
    let left = this.parseTerm();
    while (
      this.peek().t === "op" &&
      ((this.peek() as { v: string }).v === "+" || (this.peek() as { v: string }).v === "-")
    ) {
      const op = (this.next() as { v: string }).v;
      left = { k: "binop", op, l: left, r: this.parseTerm() };
    }
    return left;
  }
  private parseTerm(): ValNode {
    let left = this.parseFactor();
    while (
      this.peek().t === "op" &&
      ((this.peek() as { v: string }).v === "*" || (this.peek() as { v: string }).v === "/")
    ) {
      const op = (this.next() as { v: string }).v;
      left = { k: "binop", op, l: left, r: this.parseFactor() };
    }
    return left;
  }
  private parseFactor(): ValNode {
    const tok = this.peek();
    if (tok.t === "num") {
      this.pos++;
      return { k: "num", n: tok.v };
    }
    if (tok.t === "str") {
      this.pos++;
      return { k: "str", s: tok.v };
    }
    if (tok.t === "punct" && tok.v === "(") {
      this.pos++;
      const inner = this.parseValueExpr();
      this.expectPunct(")");
      return inner;
    }
    if (tok.t === "ident") {
      const next = this.tokens[this.pos + 1];
      if (next?.t === "punct" && next.v === "(") {
        const fn = tok.v.toUpperCase();
        if (fn === "FLOAT") {
          this.pos += 2;
          const e = this.parseValueExpr();
          this.expectPunct(")");
          return { k: "float", e };
        }
        if (fn === "REPLACE") {
          this.pos += 2;
          const e = this.parseValueExpr();
          this.expectPunct(",");
          const search = this.next();
          if (search.t !== "str")
            throw new LegacyInspectCsvqError("REPLACE search must be a string");
          this.expectPunct(",");
          const replacement = this.next();
          if (replacement.t !== "str") {
            throw new LegacyInspectCsvqError("REPLACE replacement must be a string");
          }
          this.expectPunct(")");
          return { k: "replace", e, search: search.v, replacement: replacement.v };
        }
      }
      return { k: "col", name: this.parseColRef() };
    }
    throw new LegacyInspectCsvqError("expected a value");
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type EvalValue =
  | { readonly kind: "null" }
  | { readonly kind: "num"; readonly n: number }
  | { readonly kind: "str"; readonly s: string };

const NULL_VALUE: EvalValue = { kind: "null" };

// Go's strconv accepts no surrounding whitespace and no digit grouping. Mirror
// that strictly so a `to_char`-formatted value (e.g. `" 2,000"`) does NOT convert
// to a number and falls back to a string comparison, exactly as csvq does.
const STRICT_NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function toNumber(value: EvalValue): number | undefined {
  if (value.kind === "num") return value.n;
  if (value.kind === "str" && STRICT_NUMERIC.test(value.s)) {
    const n = Number(value.s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toStringValue(value: EvalValue): string {
  if (value.kind === "str") return value.s;
  if (value.kind === "num") return String(value.n);
  return "";
}

function evalVal(node: ValNode, table: LegacyCsvTable, row: ReadonlyArray<string>): EvalValue {
  switch (node.k) {
    case "num":
      return { kind: "num", n: node.n };
    case "str":
      return { kind: "str", s: node.s };
    case "col": {
      const index = table.columns.get(node.name.toLowerCase());
      if (index === undefined) {
        throw new LegacyInspectCsvqError(`unknown column: ${node.name}`);
      }
      return { kind: "str", s: row[index] ?? "" };
    }
    case "binop": {
      if (node.op === "||") {
        return {
          kind: "str",
          s:
            toStringValue(evalVal(node.l, table, row)) + toStringValue(evalVal(node.r, table, row)),
        };
      }
      const l = toNumber(evalVal(node.l, table, row));
      const r = toNumber(evalVal(node.r, table, row));
      if (l === undefined || r === undefined) return NULL_VALUE;
      switch (node.op) {
        case "+":
          return { kind: "num", n: l + r };
        case "-":
          return { kind: "num", n: l - r };
        case "*":
          return { kind: "num", n: l * r };
        case "/":
          return r === 0 ? NULL_VALUE : { kind: "num", n: l / r };
        default:
          throw new LegacyInspectCsvqError(`unsupported operator: ${node.op}`);
      }
    }
    case "float": {
      const n = Number(toStringValue(evalVal(node.e, table, row)));
      return Number.isFinite(n) ? { kind: "num", n } : NULL_VALUE;
    }
    case "replace": {
      const value = toStringValue(evalVal(node.e, table, row));
      return { kind: "str", s: value.replaceAll(node.search, node.replacement) };
    }
  }
}

type Tri = true | false | null;

function compareValues(op: string, left: EvalValue, right: EvalValue): Tri {
  if (left.kind === "null" || right.kind === "null") return null;
  const ln = toNumber(left);
  const rn = toNumber(right);
  let cmp: number;
  if (ln !== undefined && rn !== undefined) {
    cmp = ln < rn ? -1 : ln > rn ? 1 : 0;
  } else {
    const ls = toStringValue(left);
    const rs = toStringValue(right);
    cmp = ls < rs ? -1 : ls > rs ? 1 : 0;
  }
  switch (op) {
    case "=":
      return cmp === 0;
    case "<>":
    case "!=":
      return cmp !== 0;
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    default:
      throw new LegacyInspectCsvqError(`unsupported comparison: ${op}`);
  }
}

function evalCond(node: CondNode, table: LegacyCsvTable, row: ReadonlyArray<string>): Tri {
  switch (node.k) {
    case "or": {
      const l = evalCond(node.l, table, row);
      const r = evalCond(node.r, table, row);
      if (l === true || r === true) return true;
      if (l === false && r === false) return false;
      return null;
    }
    case "and": {
      const l = evalCond(node.l, table, row);
      const r = evalCond(node.r, table, row);
      if (l === false || r === false) return false;
      if (l === true && r === true) return true;
      return null;
    }
    case "not": {
      const e = evalCond(node.e, table, row);
      return e === null ? null : !e;
    }
    case "cmp":
      return compareValues(node.op, evalVal(node.l, table, row), evalVal(node.r, table, row));
    case "isnull": {
      // CSV cells are never NULL, so `IS NULL` is always false here (and the
      // negated form always true). Computed expressions can be NULL.
      const value = evalVal(node.e, table, row);
      const isNull = value.kind === "null";
      return node.negated ? !isNull : isNull;
    }
  }
}

function matchedRows(stmt: SelectStmt, table: LegacyCsvTable): Array<ReadonlyArray<string>> {
  if (stmt.where === undefined) return [...table.rows];
  const where = stmt.where;
  return table.rows.filter((row) => evalCond(where, table, row) === true);
}

function columnIndex(table: LegacyCsvTable, name: string): number {
  const index = table.columns.get(name.toLowerCase());
  if (index === undefined) throw new LegacyInspectCsvqError(`unknown column: ${name}`);
  return index;
}

function evalAggregate(
  agg: AggNode,
  table: LegacyCsvTable,
  rows: Array<ReadonlyArray<string>>,
): Option.Option<string> {
  if (agg.fn === "COUNT" && agg.star === true) {
    return Option.some(String(rows.length));
  }
  // Resolve the aggregate's column up front, so an unknown column errors at
  // "bind time" regardless of how many rows match — matching csvq, which validates
  // referenced columns against the table schema before evaluating rows. (This is
  // what surfaces default rule 6's `s.tbl` typo as a STATUS cell even when the
  // matched set is empty.)
  const index = columnIndex(table, agg.col!);
  if (agg.fn === "COUNT") {
    // CSV cells are never NULL, so COUNT(col) == COUNT(*) == the matched-row count.
    return Option.some(String(rows.length));
  }
  if (agg.fn === "LISTAGG") {
    if (rows.length === 0) return Option.none();
    return Option.some(rows.map((row) => row[index] ?? "").join(agg.sep ?? ""));
  }
  // SUM / MIN / MAX / AVG over the strictly-numeric matched cells.
  const nums = rows
    .map((row) => toNumber({ kind: "str", s: row[index] ?? "" }))
    .filter((n): n is number => n !== undefined);
  if (nums.length === 0) return Option.none();
  switch (agg.fn) {
    case "SUM":
      return Option.some(String(nums.reduce((a, b) => a + b, 0)));
    case "AVG":
      return Option.some(String(nums.reduce((a, b) => a + b, 0) / nums.length));
    case "MIN":
      return Option.some(String(Math.min(...nums)));
    case "MAX":
      return Option.some(String(Math.max(...nums)));
  }
}

/**
 * Provides the parsed CSV table for a backtick-quoted table name (e.g.
 * `locks.csv`). Returns `undefined` when the table does not exist, which the
 * evaluator surfaces as an error (→ the rule's STATUS cell).
 */
export type LegacyCsvTableProvider = (name: string) => LegacyCsvTable | undefined;

/**
 * Evaluate a csvq rule query to its scalar first-column result.
 *
 * Returns `Option.none()` for the two cases Go maps to a passing rule with a `-`
 * matches cell: an aggregate over zero matched rows (csvq NULL) and a
 * non-aggregate select that matches no rows (`sql.ErrNoRows`). Returns
 * `Option.some(value)` otherwise — including `Option.some("")` for a valid empty
 * string, which Go also treats as a pass but renders as an empty matches cell.
 *
 * Throws `LegacyInspectCsvqError` for unsupported grammar, an unknown table, or an
 * unknown column; the rule evaluator catches it and uses the message as the STATUS
 * cell (Go does the same with csvq's own error text).
 */
export function legacyEvalCsvqScalar(
  query: string,
  provider: LegacyCsvTableProvider,
): Option.Option<string> {
  const duplicateIndexes = evalDuplicateIndexesQuery(query, provider);
  if (duplicateIndexes !== undefined) return duplicateIndexes;

  const stmt = new Parser(tokenize(query)).parse();
  const table = provider(stmt.table);
  if (table === undefined) {
    throw new LegacyInspectCsvqError(`table not found: ${stmt.table}`);
  }
  const rows = matchedRows(stmt, table);
  if (stmt.agg !== undefined) {
    return evalAggregate(stmt.agg, table, rows);
  }
  // Plain scalar select: first matched row's expression, or none (ErrNoRows).
  const first = rows[0];
  return first === undefined
    ? Option.none()
    : Option.some(toStringValue(evalVal(stmt.expr!, table, first)));
}

const DUPLICATE_INDEXES_QUERY =
  "SELECT LISTAGG(i.name, ',') AS match FROM `index_stats.csv` AS i JOIN (SELECT `table`, columns FROM `index_stats.csv` GROUP BY `table`, columns HAVING COUNT(*) > 1) AS d ON i.`table` = d.`table` AND i.columns = d.columns";

function evalDuplicateIndexesQuery(
  query: string,
  provider: LegacyCsvTableProvider,
): Option.Option<string> | undefined {
  if (query.trim().replace(/;$/, "") !== DUPLICATE_INDEXES_QUERY) return undefined;
  const table = provider("index_stats.csv");
  if (table === undefined) {
    throw new LegacyInspectCsvqError("table not found: index_stats.csv");
  }
  const nameIndex = columnIndex(table, "name");
  const tableIndex = columnIndex(table, "table");
  const columnsIndex = columnIndex(table, "columns");
  const groups = new Map<string, number>();
  for (const row of table.rows) {
    const key = `${row[tableIndex] ?? ""}\u0000${row[columnsIndex] ?? ""}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const matches = table.rows
    .filter((row) => {
      const key = `${row[tableIndex] ?? ""}\u0000${row[columnsIndex] ?? ""}`;
      return (groups.get(key) ?? 0) > 1;
    })
    .map((row) => row[nameIndex] ?? "");
  return matches.length === 0 ? Option.none() : Option.some(matches.join(","));
}
