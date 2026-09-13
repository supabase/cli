import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Parses a pflag `StringSliceVar` flag: CSV-splits each occurrence, matching
 * `encoding/csv`, and accumulates across repeats. A naive `.split(",")`
 * diverges on quoted/embedded commas (e.g. `'"a,b",c'`).
 *
 * Whitespace is not trimmed and empty fields are not dropped.
 */
import { Flag } from "effect/unstable/cli";

const QUOTE = 0x22; // "
const COMMA = 0x2c; // ,
const LF = 0x0a; // \n
const CR = 0x0d; // \r

const EMPTY = new Uint8Array(0);

/** Number of bytes for the trailing `\n`, if any. */
const lengthNL = (b: Uint8Array): number => (b.length > 0 && b[b.length - 1] === LF ? 1 : 0);

/**
 * Thrown by `parseStringSliceFlag` when a value is not valid CSV.
 *
 * `message` is either a `parse error on line N, column N: <detail>` string
 * (with a `record on line N; ` prefix when the record started on an earlier
 * line), or the literal `EOF` when the value is only blank lines.
 */
export class StringSliceFlagParseError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "StringSliceFlagParseError";
  readonly value: string;
  private constructor(value: string, message: string) {
    super(message);
    this.name = "StringSliceFlagParseError";
    this.value = value;
  }
  /** Line/column are 1-based; column is a byte offset within the physical line. */
  static parse(
    value: string,
    startLine: number,
    line: number,
    column: number,
    detail: string,
  ): StringSliceFlagParseError {
    const location = `parse error on line ${line}, column ${column}: ${detail}`;
    return new StringSliceFlagParseError(
      value,
      startLine !== line ? `record on line ${startLine}; ${location}` : location,
    );
  }
  /** Value is nothing but blank lines. */
  static eof(value: string): StringSliceFlagParseError {
    return new StringSliceFlagParseError(value, "EOF");
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Parses one CSV record from `val`, matching Go's `encoding/csv` reader as
 * used by pflag's `readAsCSV`. Only the first record is read — an unquoted
 * newline ends it and the rest is dropped. Blank lines before the record are
 * skipped; blank-only input throws `EOF`. `\r\n` normalizes to `\n`, and
 * parse errors report 1-based line/byte-column positions.
 */
function readAsCSVStrict(val: string): string[] {
  if (val === "") return [];
  // ASCII delimiters never appear inside multibyte UTF-8 sequences, so byte
  // scanning is exact and columns come out in bytes for free.
  const input = new TextEncoder().encode(val);
  let offset = 0;
  let numLine = 0;

  // Returns one line including its trailing `\n`, with `\r\n` normalized to
  // `\n` and a trailing `\r` before EOF dropped. Returns null at EOF.
  const readLine = (): Uint8Array | null => {
    if (offset >= input.length) return null;
    const nl = input.indexOf(LF, offset);
    let line: Uint8Array;
    if (nl >= 0) {
      line = input.subarray(offset, nl + 1);
      offset = nl + 1;
    } else {
      line = input.subarray(offset);
      offset = input.length;
      // A trailing \r before EOF is dropped.
      if (line.length > 0 && line[line.length - 1] === CR) {
        line = line.subarray(0, line.length - 1);
      }
    }
    numLine++;
    // Normalize \r\n to \n. Mutating is safe: `input` is our own copy and
    // these bytes are never re-read.
    const n = line.length;
    if (n >= 2 && line[n - 2] === CR && line[n - 1] === LF) {
      line[n - 2] = LF;
      line = line.subarray(0, n - 1);
    }
    return line;
  };

  // Read the record's first line, skipping past blank lines. EOF here
  // throws the `EOF` error.
  let line: Uint8Array;
  for (;;) {
    const next = readLine();
    if (next === null) throw StringSliceFlagParseError.eof(val);
    if (next.length === lengthNL(next)) continue; // Skip empty lines
    line = next;
    break;
  }

  const recLine = numLine; // Starting line for record
  const pos = { line: numLine, col: 1 };
  const recordBuffer: number[] = [];
  const fieldIndexes: number[] = [];
  const append = (bytes: Uint8Array): void => {
    for (const byte of bytes) recordBuffer.push(byte);
  };

  parseField: for (;;) {
    if (line.length === 0 || line[0] !== QUOTE) {
      // Non-quoted string field
      const comma = line.indexOf(COMMA);
      const field =
        comma >= 0 ? line.subarray(0, comma) : line.subarray(0, line.length - lengthNL(line));
      // Check to make sure a quote does not appear in the field.
      const bareQuote = field.indexOf(QUOTE);
      if (bareQuote >= 0) {
        throw StringSliceFlagParseError.parse(
          val,
          recLine,
          numLine,
          pos.col + bareQuote,
          `bare " in non-quoted-field`,
        );
      }
      append(field);
      fieldIndexes.push(recordBuffer.length);
      if (comma >= 0) {
        line = line.subarray(comma + 1);
        pos.col += comma + 1;
        continue parseField;
      }
      break parseField;
    } else {
      // Quoted string field
      line = line.subarray(1);
      pos.col += 1;
      for (;;) {
        const quote = line.indexOf(QUOTE);
        if (quote >= 0) {
          // Hit next quote.
          append(line.subarray(0, quote));
          line = line.subarray(quote + 1);
          pos.col += quote + 1;
          if (line.length > 0 && line[0] === QUOTE) {
            // `""` sequence (append quote).
            recordBuffer.push(QUOTE);
            line = line.subarray(1);
            pos.col += 1;
          } else if (line.length > 0 && line[0] === COMMA) {
            // `",` sequence (end of field).
            line = line.subarray(1);
            pos.col += 1;
            fieldIndexes.push(recordBuffer.length);
            continue parseField;
          } else if (lengthNL(line) === line.length) {
            // `"\n` sequence: end of line; remaining input is dropped (only one record is read).
            fieldIndexes.push(recordBuffer.length);
            break parseField;
          } else {
            // `"*` sequence: invalid non-escaped quote; reports the byte position of the closing quote.
            throw StringSliceFlagParseError.parse(
              val,
              recLine,
              numLine,
              pos.col - 1,
              `extraneous or missing " in quoted-field`,
            );
          }
        } else if (line.length > 0) {
          // Hit end of line: copy all data so far, including the `\n`, since a
          // quoted multiline field keeps its newline.
          append(line);
          pos.col += line.length;
          const next = readLine();
          if (next !== null && next.length > 0) {
            pos.line++;
            pos.col = 1;
          }
          line = next ?? EMPTY;
        } else {
          // Abrupt end of file: ran off the end without a closing quote, so
          // the reported column is one past the final byte of the last line.
          throw StringSliceFlagParseError.parse(
            val,
            recLine,
            pos.line,
            pos.col,
            `extraneous or missing " in quoted-field`,
          );
        }
      }
    }
  }

  const record = new Uint8Array(recordBuffer);
  const decoder = new TextDecoder();
  const fields: string[] = [];
  let preIdx = 0;
  for (const idx of fieldIndexes) {
    fields.push(decoder.decode(record.subarray(preIdx, idx)));
    preIdx = idx;
  }
  return fields;
}

/**
 * CSV-parses and flattens all raw occurrences of a repeated `StringSlice`
 * flag. Throws `StringSliceFlagParseError` on the first malformed value,
 * failing the command before it runs.
 *
 * Quoted commas stay in one field (`"tenant,one"` → `["tenant,one"]`);
 * whitespace is not trimmed; an unquoted newline keeps only the first line.
 */
export function parseStringSliceFlag(rawValues: ReadonlyArray<string>): ReadonlyArray<string> {
  const values: string[] = [];
  for (const value of rawValues) {
    for (const field of readAsCSVStrict(value)) {
      values.push(field);
    }
  }
  return values;
}

/**
 * Builds a repeatable CSV-split flag matching pflag's `StringSliceVar`
 * behavior, including its `invalid argument %q for %q flag: %v` diagnostic.
 *
 * `options.alias` must be registered here, not piped on afterwards: pflag's
 * diagnostic frames both spellings (`-x, --exclude`), so the alias must be
 * present when the error message is built.
 */
export function stringSliceFlag(
  name: string,
  description: string,
  options?: { readonly alias?: string },
) {
  const alias = options?.alias;
  const pflagName = alias === undefined ? `--${name}` : `-${alias}, --${name}`;
  const base = Flag.string(name).pipe(Flag.withDescription(description), Flag.atLeast(0));
  return (alias === undefined ? base : base.pipe(Flag.withAlias(alias))).pipe(
    Flag.mapTryCatch(
      (rawValues) => parseStringSliceFlag(rawValues),
      (err) =>
        err instanceof StringSliceFlagParseError
          ? `invalid argument ${JSON.stringify(err.value)} for "${pflagName}" flag: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
    ),
  );
}
