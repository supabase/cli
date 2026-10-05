import { Schema } from "effect";

/**
 * Fails decoding when the input carries keys the struct does not declare. Parse-option
 * annotations no longer influence decoding, and the RPC transport passes no parse options, so
 * strictness has to live in the schema itself.
 */
export const rejectExcessKeys = <S extends Schema.Struct<Schema.Struct.Fields>>(struct: S) =>
  Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.check(
      Schema.makeFilter((input) => {
        const excess = Object.keys(input).filter((key) => !(key in struct.fields));
        return excess.length === 0 ? undefined : `Unexpected keys: ${excess.join(", ")}`;
      }),
    ),
    Schema.decodeTo(struct),
  );
