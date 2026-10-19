import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { TomlDate } from "smol-toml";

import { parseBase0Bigint } from "../shared/config/parse-uint.ts";
import { parseBoolLiteral } from "../shared/config/config-bool.ts";

const MAX_UINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_PORT = 65535;

/** A schema pair per value type: `fromString` decodes env and flag text, `fromDocument` a typed config value. */
export interface CliConfigCodecSchemas<X> {
  readonly fromString: Schema.Codec<X, string>;
  readonly fromDocument: Schema.Codec<X, unknown>;
}

const parsed = <E, T>(parse: (input: E) => T | undefined) =>
  SchemaGetter.transformEffect<T, E>((input) => {
    const value = parse(input);
    return value === undefined
      ? Effect.fail(new SchemaIssue.InvalidValue(undefined, input))
      : Effect.succeed(value);
  });

const parseUintUpTo = (max: bigint) => (raw: string) => {
  const value = parseBase0Bigint(raw);
  return value === undefined || value > max ? undefined : Number(value);
};

const integerUpTo = (max: number) => (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;

const parsePort = (raw: string) =>
  /^0[0-9_]/.test(raw) ? undefined : parseUintUpTo(BigInt(MAX_PORT))(raw);

const integerFromString = (parse: (raw: string) => number | undefined) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.Number, {
      decode: parsed(parse),
      encode: SchemaGetter.transform((value: number) => String(value)),
    }),
  );

const integerFromNumber = (max: number) =>
  Schema.Number.pipe(
    Schema.decodeTo(Schema.Number, {
      decode: parsed(integerUpTo(max)),
      encode: SchemaGetter.passthrough(),
    }),
  );

const integerSchemas = (
  parse: (raw: string) => number | undefined,
  max: number,
): CliConfigCodecSchemas<number> => {
  const fromString = integerFromString(parse);
  return {
    fromString,
    fromDocument: Schema.Union([fromString, integerFromNumber(max)]),
  };
};

const boolFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: parsed(parseBoolLiteral),
    encode: SchemaGetter.transform((value: boolean) => String(value)),
  }),
);

const boolFromNumber = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value: number) => value !== 0),
    encode: SchemaGetter.transform((value: boolean) => (value ? 1 : 0)),
  }),
);

export const boolSchemas: CliConfigCodecSchemas<boolean> = {
  fromString: boolFromString,
  fromDocument: Schema.Union([Schema.Boolean, boolFromNumber, boolFromString]),
};

export const uintSchemas = integerSchemas(parseUintUpTo(MAX_UINT), Number.MAX_SAFE_INTEGER);

export const portSchemas = integerSchemas(parsePort, MAX_PORT);

export const stringSchemas: CliConfigCodecSchemas<string> = {
  fromString: Schema.String,
  fromDocument: Schema.String,
};

/** No trimming; the empty string is the empty list. */
const listFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.split<string>(),
    encode: SchemaGetter.transform((values: ReadonlyArray<string>) => values.join(",")),
  }),
);

export const commaListSchemas: CliConfigCodecSchemas<ReadonlyArray<string>> = {
  fromString: listFromString,
  fromDocument: Schema.Union([listFromString, Schema.Array(Schema.String)]),
};

/** A float rendered in fixed notation, with `+Inf`/`-Inf`/`NaN` and a signed zero spelled out. */
const formatWeakFloat = (value: number): string => {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Object.is(value, -0)) return "-0";
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign = "", intPart = "", fracPart = "", exponent = "0"] = match;
  const digits = intPart + fracPart;
  const pointAt = intPart.length + Number(exponent);
  if (pointAt <= 0) return `${sign}0.${"0".repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${"0".repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
};

/** A bool becomes `"1"`/`"0"` and a number its decimal text; anything else is not a scalar. */
const weakGlobEntry = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return formatWeakFloat(value);
  if (typeof value === "bigint") return value.toString();
  return undefined;
};

export const unsupportedTypeName = (value: unknown): string | undefined => {
  if (value instanceof TomlDate) {
    if (value.isDate()) return "local date";
    if (value.isTime()) return "local time";
    return value.isLocal() ? "local date-time" : "offset date-time";
  }
  if (Array.isArray(value)) return "array";
  return typeof value === "object" && value !== null ? "table" : undefined;
};

const isEmptyTable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof TomlDate) &&
  Object.keys(value).length === 0;

export const globEntries = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (typeof value === "string") return undefined;
  if (Array.isArray(value)) return value;
  return isEmptyTable(value) ? [] : [value];
};

const globFromScalarOrArray = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: parsed((value: unknown) => {
      const decoded = (globEntries(value) ?? []).map(weakGlobEntry);
      return decoded.every((entry) => entry !== undefined) ? decoded : undefined;
    }),
    encode: SchemaGetter.passthrough(),
  }),
);

/** Weak decoding: a bare string is comma-split; numbers and bools in a scalar or array become their text. */
export const globListSchemas: CliConfigCodecSchemas<ReadonlyArray<string>> = {
  fromString: listFromString,
  fromDocument: Schema.Union([listFromString, globFromScalarOrArray]),
};

export const literalSchemas = <const T extends string>(
  values: ReadonlyArray<T>,
): CliConfigCodecSchemas<T> => {
  const literal = Schema.Literals(values);
  return { fromString: literal, fromDocument: literal };
};
