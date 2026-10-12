import { Schema, SchemaGetter } from "effect";

const stripUndefinedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefinedValue);
  if (typeof value === "object" && value !== null) return stripUndefined(Object.entries(value));
  return value;
};

/** Drops `undefined` values recursively so optional fields set to `undefined` survive the JSON codec. */
const stripUndefined = (entries: ReadonlyArray<readonly [string, unknown]>) =>
  Object.fromEntries(
    entries
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedValue(entry)]),
  );

/**
 * Fails decoding when the input carries keys the struct does not declare. Parse-option
 * annotations no longer influence decoding, and the RPC transport passes no parse options, so
 * strictness has to live in the schema itself.
 */
export const rejectExcessKeys = <S extends Schema.Struct<Schema.Struct.Fields>>(struct: S) =>
  Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.check(
      Schema.makeFilter((input) =>
        Object.keys(input)
          .filter((key) => !Object.hasOwn(struct.fields, key))
          .map((key) => ({ path: [key], issue: "Expected no excess property" })),
      ),
    ),
    Schema.decodeTo(struct, {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transform((input) => stripUndefined(Object.entries(input))),
    }),
  );
