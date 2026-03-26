import { Schema } from "effect";

export const ENV_PATTERN = "^env\\([A-Z_][A-Z0-9_]*\\)$";
export const ENV_CAPTURE_REGEX = /^env\(([A-Z_][A-Z0-9_]*)\)$/;
const envRegex = new RegExp(ENV_PATTERN);

export function isEnvReference(value: string): boolean {
  return envRegex.test(value);
}

interface EnvAnnotations extends Schema.Annotations.Documentation<string> {
  readonly secret?: true;
}

export const env = (annotations?: EnvAnnotations) => {
  const { secret, ...rest } = annotations ?? {};
  return Schema.String.check(Schema.isPattern(envRegex)).annotate({
    ...rest,
    ...(secret ? { "x-secret": true } : {}),
  });
};

interface SecretAnnotations extends Schema.Annotations.Documentation<string> {}

export const secret = (annotations?: SecretAnnotations) =>
  Schema.String.annotate({
    ...annotations,
    "x-secret": true,
  });
