import { Schema } from "effect";

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
