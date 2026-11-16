import { type Effect, Schema, SchemaGetter, type SchemaIssue } from "effect";

interface LinkMetadata {
  readonly name: string;
  readonly link: string;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Augment {
      readonly tags?: ReadonlyArray<string> | undefined;
      readonly links?: ReadonlyArray<LinkMetadata> | undefined;
      readonly ["x-secret"]?: boolean | undefined;
    }
  }
}

export const stringEnum = <Values extends ReadonlyArray<string>>(
  values: Values,
  annotations?: Schema.Annotations.Documentation<Values[number]>,
) => {
  const schema = Schema.Literals(values);
  return annotations === undefined ? schema : schema.annotate(annotations);
};

/**
 * Record-value counterpart of `Schema.withDecodingDefault`: an entry whose value is `undefined`
 * decodes to the `Encoded` default. Record values reject `Schema.optional`, so the encoded side is
 * `Schema.UndefinedOr` instead.
 */
export const withRecordValueDecodingDefault =
  <S extends Schema.Constraint, R = never>(
    defaultValue: Effect.Effect<S["Encoded"], SchemaIssue.Issue, R>,
  ) =>
  (self: S) =>
    Schema.UndefinedOr(Schema.toEncoded(self)).pipe(
      Schema.decodeTo(self, {
        decode: SchemaGetter.withDefault(defaultValue),
        encode: SchemaGetter.passthrough(),
      }),
    );
